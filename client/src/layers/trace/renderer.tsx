import { map, merge } from "es-toolkit/compat";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useThrottle } from "react-use";

import { useRendererInstance } from "components/inspector/TraceRenderer";
import { NodeList, PersistentNodes } from "components/renderer/NodeList";
import { buildComponentStore } from "components/renderer/parser-v140/componentStoreClient";
import { StreamingPersistentNodes } from "components/renderer/StreamingPersistentNodes";
import { useTraceContent } from "hooks/useTraceContent";
import { Trace } from "protocol/Trace-v140";
import { ComponentEntry, SourceHandle } from "renderer";
import { TraceLayer } from "./TraceLayer";
import { getStreamBuffers, TraceStreamHandle } from "./traceStreamStore";
import { Controller } from "./types";
import { use2DPath } from "./use2DPath";
import { useEventContext } from "./useEventContext";

export interface RendererProps {
  layer?: TraceLayer;
  index?: number;
}

const metaFor = (layer?: TraceLayer, index?: number) => ({
  sourceLayer: layer?.key,
  sourceLayerIndex: index,
  sourceLayerAlpha: 1 - 0.01 * +(layer?.transparency ?? 0),
  sourceLayerDisplayMode: layer?.displayMode ?? "source-over",
});

/**
 * Streaming renderer (v1.4.0 trusted). Reads frame components from the external
 * buffer store and reacts to `stream.version`/`frontier`. Layer meta is applied
 * at *add-time* (here and in `StreamingPersistentNodes`) instead of by re-mapping
 * the whole component arrays on every change — the latter would be O(n) per
 * commit (O(n²) over a stream).
 */
function StreamingRenderer({
  layer,
  index,
  stream,
}: RendererProps & { stream: TraceStreamHandle }) {
  const step = useThrottle(layer?.source?.step ?? 0, 1000 / 60);
  const path = use2DPath(layer, index, step);

  const buffers = getStreamBuffers(stream.streamKey);
  const { version, frontier } = stream;
  const metaKey = `${layer?.key}:${index}:${layer?.transparency}:${layer?.displayMode}`;

  const decorate = useCallback(
    (entries: ComponentEntry[]) => {
      const meta = metaFor(layer, index);
      return map(entries, (d) => merge({}, d, { meta }));
    },
    [layer, index],
  );

  // Transient at the playhead: fully-merged when within the contiguous frontier,
  // otherwise the (approximate) own-frame components as a partial preview.
  // Computed inline (not memoized): `version` changing re-renders this component,
  // and the work is a couple of array reads. `version` is referenced so the
  // dependency is explicit to readers even though buffers mutate in place.
  void version;
  let transient: ComponentEntry[] = [];
  if (buffers) {
    const merged = step < frontier ? buffers.mergedTransient[step] : undefined;
    transient = merged ?? (buffers.generated[step] ? buffers.transientOwn[step] : undefined) ?? [];
  }
  const transientSteps = [decorate(transient)];

  return (
    <>
      <StreamingPersistentNodes
        buffers={buffers}
        step={step}
        version={version}
        metaKey={metaKey}
        decorate={decorate}
      />
      <NodeList nodes={transientSteps} />
      {path}
    </>
  );
}

/** One-shot renderer (legacy formats / untrusted layers). Behaviour unchanged. */
function LegacyRenderer({ layer, index }: RendererProps) {
  const parsedTrace = layer?.source?.parsedTrace?.components;
  const step = useThrottle(layer?.source?.step ?? 0, 1000 / 60);

  const path = use2DPath(layer, index, step);
  const persistentSteps = useMemo(
    () =>
      map(parsedTrace?.stepsPersistent, (c) =>
        map(c, (d) =>
          merge({}, d, {
            meta: {
              sourceLayer: layer?.key,
              sourceLayerIndex: index,
              sourceLayerAlpha: 1 - 0.01 * +(layer?.transparency ?? 0),
              sourceLayerDisplayMode: layer?.displayMode ?? "source-over",
            },
          }),
        ),
      ),
    [parsedTrace?.stepsPersistent, layer?.key, layer?.transparency, layer?.displayMode, index],
  );
  const steps1 = useMemo(
    () =>
      map(parsedTrace?.stepsTransient, (c) =>
        map(c, (d) =>
          merge({}, d, {
            meta: {
              sourceLayer: layer?.key,
              sourceLayerIndex: index,
              sourceLayerAlpha: 1 - 0.01 * +(layer?.transparency ?? 0),
              sourceLayerDisplayMode: layer?.displayMode ?? "source-over",
            },
          }),
        ),
      ),
    [parsedTrace?.stepsTransient, layer?.key, layer?.transparency, layer?.displayMode, index],
  );
  const transientSteps = useMemo(() => [steps1[step] ?? []], [steps1, step]);
  return (
    <>
      <PersistentNodes step={step} nodes={persistentSteps} />
      <NodeList nodes={transientSteps} />
      {path}
    </>
  );
}

/**
 * Load-based feed for renderers advertising `supportsLoad` (d2-renderer-v2).
 * Instead of streaming per-step component chunks via `add()`, it builds the
 * whole trace into a shared columnar store once and `load()`s it, then drives
 * visibility with `setStep`. Streaming preview is deliberately second-class:
 * nothing renders until the (off-main) build completes.
 */
function LoadRenderer({ layer, index }: RendererProps) {
  const { renderer } = useRendererInstance();
  const context = useEventContext();
  const { result: trace } = useTraceContent(layer?.source?.trace);
  const content = trace?.content as Trace | undefined;
  const traceKey = trace?.key;
  const step = useThrottle(layer?.source?.step ?? 0, 1000 / 60);

  const stepRef = useRef(step);
  stepRef.current = step;
  const contextKey = JSON.stringify(context ?? {});

  // Compositing params (order/alpha/blend), mirroring the streaming path's
  // `metaFor`. Updating these is free — no store rebuild.
  const params = useMemo(
    () => ({
      index,
      alpha: 1 - 0.01 * Number(layer?.transparency ?? 0),
      displayMode: (layer?.displayMode ?? "source-over") as GlobalCompositeOperation,
    }),
    [index, layer?.transparency, layer?.displayMode],
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const handleRef = useRef<SourceHandle | undefined>(undefined);

  useEffect(() => {
    if (!renderer?.load || !content?.events?.length) return;
    const controller = new AbortController();
    (async () => {
      const store = await buildComponentStore({
        trace: content,
        context,
        view: "main",
        traceKey,
        signal: controller.signal,
      });
      if (controller.signal.aborted || !store || !renderer.load) return;
      handleRef.current = renderer.load(store, paramsRef.current);
      renderer.setStep?.(stepRef.current);
    })();
    return () => {
      controller.abort();
      if (handleRef.current) renderer.unload?.(handleRef.current);
      handleRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, content, contextKey, traceKey]);

  // Free compositing updates on the already-loaded layer.
  useEffect(() => {
    if (handleRef.current) renderer?.setLayerParams?.(handleRef.current, params);
  }, [renderer, params]);

  useEffect(() => {
    renderer?.setStep?.(step);
  }, [renderer, step]);

  return <></>;
}

function RendererDispatch({ layer, index }: RendererProps) {
  const { renderer } = useRendererInstance();
  const stream = layer?.source?.parsedTrace?.stream;
  // Prefer the shared-store path when the active renderer supports it.
  if (renderer?.load) return <LoadRenderer layer={layer} index={index} />;
  return stream ? (
    <StreamingRenderer layer={layer} index={index} stream={stream} />
  ) : (
    <LegacyRenderer layer={layer} index={index} />
  );
}

export const renderer = (({ layer, index }) => (
  <RendererDispatch layer={layer} index={index} />
)) satisfies Controller["renderer"];
