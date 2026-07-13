import { useTheme } from "@mui/material";
import { clamp } from "es-toolkit";
import { floor } from "es-toolkit/compat";
import { D2RendererV2 } from "internal-renderers/src/d2-renderer/D2RendererV2";
import {
  defaultD2RendererOptions,
  type D2BodyHit,
  type D2RendererOptions,
} from "internal-renderers/src/d2-renderer/D2RendererOptions";
import { isMobile } from "mobile-device-detect";
import { useEffect, useRef, useState } from "react";
import { useDebounce } from "react-use";
import type { LayerShading, SourceHandle } from "renderer";
import type { GraphStoreResult } from "./buildGraphStore";

/**
 * The graph's own renderer instance, deliberately not the viewport's.
 *
 * **Tiles subdivide harder**, and that is now the only setting that separates the
 * two — the whole reason this isn't the viewport's instance. Tiles are striped
 * across workers one-for-one, so a tile's body count *is* a worker's share of the
 * frame — and search data is heavily clustered. On a real 717k-event trace, the
 * viewport's `tileSubdivision: 2` leaves one worker holding ~32% of every frame; at
 * 3 it is 14%, at 4 it is 6%. A map's bodies are spread evenly over its grid and
 * never had this problem.
 *
 * Dynamic resolution is off here too, but that is no longer a difference: the
 * viewport turned it off as well once the GPU calls were counted, so see
 * {@link DynamicResolutionOptions.enabled} rather than repeating the reasoning. The
 * short version is that a graph's tiles are cached against a content hash and stay
 * valid between ramp-bucket crossings — that cache is the entire reason a scrub is
 * cheap — and a ticker that flips tile size twice a second evicts exactly it.
 */
const TILE_RESOLUTION = 128;

/**
 * Tile bitmap size — and it is coupled to `tileSubdivision`, which is easy to miss.
 *
 * A tile's bitmap is stretched over its world bounds, so the pixels-per-CSS-pixel it
 * rasterizes at is `tileResolution * 2^subdivision / paneWidth`. Subdividing harder
 * shrinks a tile's world footprint while leaving its bitmap the same size, so it
 * *doubles* the sampling density for free — and the viewport's `* 2` (which lands it
 * at ~dpr for its `tileSubdivision: 2`) becomes ~2x oversampling here at 3. That is
 * 4x the fill rate for pixels no display can show, and on the 717k-point scatter it
 * is the difference between a splat costing 29 and 225 pixels.
 *
 * So the `* 2` comes off, exactly cancelling the extra subdivision.
 */
const tile = devicePixelRatio * TILE_RESOLUTION * (isMobile ? 0.25 : 1);

const rendererOptions: Partial<D2RendererOptions> = {
  tileSubdivision: isMobile ? 2 : 3,
  workerCount: clamp(floor(navigator.hardwareConcurrency / 4), 1, 12),
  tileResolution: { width: tile, height: tile },
  dynamicResolution: { ...defaultD2RendererOptions.dynamicResolution, enabled: false },
};

export type GraphRendererProps = {
  width?: number;
  height?: number;
  graph?: GraphStoreResult;
  step: number;
  shading?: LayerShading;
  /**
   * Opacity of the un-searched tree. A layer param, so dragging it re-composites
   * from the tile cache — it never re-rasterizes, repacks a column, or rebuilds an
   * index.
   *
   * Defaults to opaque, because the ghost's *colour* already carries the fading:
   * it is a blend a tenth of the way from the background towards the foreground
   * (see `ghostColor`), which is what sigma painted un-visited nodes. Dimming that
   * again would land it at a twenty-fifth of the way and reintroduce the "where did
   * the tree go" problem the colour was chosen to avoid.
   */
  ghostAlpha?: number;
  /** A body was clicked, topmost first. `undefined` when empty space was hit. */
  onClickBody?: (hit: D2BodyHit | undefined, event: Event) => void;
  /** Bumped to refit the camera. */
  fitKey?: unknown;
  /** The live instance, for overlays that need the camera (see `GraphAxis`). */
  onRenderer?: (renderer?: D2RendererV2) => void;
};

export function GraphRenderer({
  width,
  height,
  graph,
  step,
  shading,
  ghostAlpha = 1,
  onClickBody,
  fitKey,
  onRenderer,
}: GraphRendererProps) {
  const theme = useTheme();
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [renderer, setRenderer] = useState<D2RendererV2>();
  const handle = useRef<SourceHandle | undefined>(undefined);
  const ghostHandle = useRef<SourceHandle | undefined>(undefined);
  // Read, never depended on: the load effect must not re-run when the playhead
  // moves (that would rebuild the spatial index 24x a second), but it does need the
  // current step to seed a freshly-loaded layer. A ref rather than an
  // eslint-disable, because disabling a rule of React makes the compiler bail out
  // of optimizing this component entirely.
  const stepRef = useRef(step);
  stepRef.current = step;
  // Same reason as `stepRef`: read to seed the layer, but changing it must not
  // reload the layer — it is applied at composite time by the effect below.
  const ghostAlphaRef = useRef(ghostAlpha);
  ghostAlphaRef.current = ghostAlpha;

  const background = theme.palette.background.paper;
  const accent = theme.palette.primary.main;

  useEffect(() => {
    if (!ref) return;
    const instance = new D2RendererV2();
    // `setup` is async — PIXI v8 builds its renderer, and so its canvas, in an async
    // `init` — so the effect can be torn down while it is still in flight. `disposed`
    // stops us mounting a renderer nobody is waiting for any more, and `mounted` keeps
    // the teardown from trying to remove a view that was never appended.
    let disposed = false;
    let mounted = false;
    const ready = instance
      .setup({
        ...rendererOptions,
        screenSize: { width: 256, height: 256 },
        backgroundColor: background,
        accentColor: accent,
      })
      .then(
        () => {
          if (disposed) return;
          ref.append(instance.getView()!);
          mounted = true;
          setRenderer(instance);
        },
        (e) => console.error(e),
      );
    return () => {
      disposed = true;
      setRenderer(undefined);
      // Deferred until setup settles: destroying a half-initialised Application throws,
      // and until then there is nothing mounted to take down.
      void ready.then(() => {
        if (mounted) {
          try {
            ref.removeChild(instance.getView()!);
          } catch (e) {
            console.warn(e);
          }
        }
        instance.destroy();
      });
    };
  }, [ref, background, accent]);

  useDebounce(
    () => {
      if (renderer && width && height) renderer.setOptions({ screenSize: { width, height } });
    },
    theme.transitions.duration.standard,
    [renderer, width, height],
  );

  // Load. Membership is fixed here; the playhead and the colour are updated
  // separately below, and neither repacks a column or rebuilds the index.
  useEffect(() => {
    if (!renderer || !graph?.store.count) return;
    // Ghosts underneath (index 0), the graph on top (index 1). The ghost layer
    // carries no labels — a faint duplicate of every node's id under the real one
    // would be unreadable — and its opacity is a layer param, not a column.
    const g = graph.ghost?.count
      ? renderer.load(graph.ghost, {
          ...graph.params,
          label: undefined,
          index: 0,
          alpha: ghostAlphaRef.current,
        })
      : undefined;
    const h = renderer.load(graph.store, { ...graph.params, index: 1 });
    ghostHandle.current = g;
    handle.current = h;
    renderer.setStep(stepRef.current);
    return () => {
      handle.current = undefined;
      ghostHandle.current = undefined;
      renderer.unload(h);
      if (g) renderer.unload(g);
    };
    // `ghostAlpha` is applied by the effect below, not here: it is a composite-time
    // param, so re-loading the layer to change it would throw away the tile cache
    // for nothing.
  }, [renderer, graph]);

  useEffect(() => {
    if (renderer && ghostHandle.current) {
      renderer.setLayerParams(ghostHandle.current, { alpha: ghostAlpha });
    }
  }, [renderer, ghostAlpha, graph]);

  useEffect(() => {
    renderer?.setStep(step);
  }, [renderer, step]);

  useEffect(() => {
    onRenderer?.(renderer);
  }, [renderer, onRenderer]);

  useEffect(() => {
    if (renderer && handle.current && shading) {
      renderer.setLayerShading(handle.current, shading);
    }
  }, [renderer, shading]);

  useEffect(() => {
    if (!renderer || !onClickBody) return;
    const f = (e: Event, hit: { bodies: D2BodyHit[] }) =>
      // Ghosts are not clickable: they are the *un*-searched tree, so there is no
      // event behind them to select.
      onClickBody(
        hit.bodies.find((x) => x.handle === handle.current),
        e,
      );
    renderer.on("clickBody", f);
    return () => void renderer.off("clickBody", f);
  }, [renderer, onClickBody]);

  // Fit when the layer becomes drawable — not on a timer.
  //
  // `load()` returns long before the layer has any bounds: the Flatbush is packed in
  // a worker, and `fitCamera` reads *that* for the extent. Firing on a fixed delay
  // is a race the big traces lose, and losing it silently leaves the graph parked
  // off-screen until the user hits Fit.
  useEffect(() => {
    if (!renderer || !graph?.store.count) return;
    const f = () => renderer.fitCamera();
    renderer.on("layerIndexed", f);
    return () => void renderer.off("layerIndexed", f);
  }, [renderer, graph, fitKey]);

  return <div ref={setRef} style={{ width, height, background, overflow: "hidden" }} />;
}
