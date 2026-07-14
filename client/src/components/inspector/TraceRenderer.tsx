import { BlurOnOutlined as DisabledIcon, ViewInArOutlined } from "@mui-symbols-material/w300";
import { Box, useTheme } from "@mui/material";
import { StatusBanner } from "components/generic/StatusBanner";
import { RendererProps, SelectEvent } from "components/renderer/Renderer";
import { RenderLayer } from "layers/RenderLayer";
import { clamp } from "es-toolkit";
import { defaultD2RendererOptions } from "internal-renderers/src/d2-renderer/D2RendererOptions";
import { find, get } from "es-toolkit/compat";
import { nanoid } from "nanoid";
import { Size } from "protocol";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useDebounce } from "react-use";
import { Renderer, RendererEvent } from "renderer";
import { slice } from "slices";
import { Placeholder } from "./Placeholder";
import { SelectionMenu } from "./SelectionMenu";
import { TrustedContent } from "./TrustedContent";
import { isMobile } from "mobile-device-detect";
import { useOne } from "slices/useOne";

const TILE_RESOLUTION = 128;

/**
 * Tile bitmap size — **one size, for the life of the renderer.** Nothing here may
 * change it at runtime, and that is the point.
 *
 * A tile's size is not a free knob. It is part of every cache key downstream, and it
 * is the one thing that forces a tile's GPU texture to be *reallocated* rather than
 * blitted into: a tile owns a single `TextureSource` for life, and PIXI's uploader
 * takes its cheap `texSubImage2D` path exactly when the incoming size matches what
 * that source already holds. Resize a tile and you re-rasterize it, evict it from the
 * workers' caches, and reallocate its texture on the GPU. Resize *every* tile and you
 * do that to the whole frustum.
 *
 * Two mechanisms used to do precisely that, and both are now gone:
 *
 * - The `dynamicResolution` ticker, which halved tile size under load — i.e. under
 *   exactly the sustained load of a scrub — and so churned the frustum every 500ms for
 *   the whole of a playback. Measured at ~150 full texture reallocations over a 12s
 *   scrub, all of it spent to *lower* the resolution of a viewport that was not
 *   dropping frames. Turned off below; see {@link DynamicResolutionOptions.enabled}.
 *
 * - A `playing` swap, which dropped the multiplier from 2 to 1.5 while the playhead
 *   ran. Cheaper than the ticker (it fired twice per playback, not continuously) but
 *   still ~98 reallocations over the same scrub, since each transition resized every
 *   tile on screen.
 *
 * The multiplier settles at the playback value, **1.5, not 2** — because that was the
 * more correct of the two all along. The bitmap is stretched over the tile's world
 * bounds, so the density it rasterizes at is `tileResolution · 2^(subdivision+0.5) /
 * paneWidth`; at `tileSubdivision: 2` that lands 1:1 with the display on a ~1080px
 * pane at 1.5, and oversamples by ~1.4x (so ~2x the fill rate) at 2, for detail no
 * display can resolve. Pinning at 1.5 therefore costs nothing that was visible and
 * makes the idle viewport cheaper than it has ever been, while leaving playback exactly
 * as expensive as it already was.
 *
 * Note the density still rides on the pane's width, which is a separate, pre-existing
 * wrinkle: this constant is tuned for a pane around 1080px, and a much wider one
 * under-samples. Deriving `tileResolution` from `screenSize` would fix that properly.
 */
const tile = devicePixelRatio * 1.5 * TILE_RESOLUTION * (isMobile ? 0.25 : 1);

const rendererOptions = {
  tileSubdivision: 2,
  // Use almost all CPUs
  workerCount: clamp(navigator.hardwareConcurrency - 1, 1, 12),
  tileResolution: { width: tile, height: tile },
  dynamicResolution: { ...defaultD2RendererOptions.dynamicResolution, enabled: false },
};

const TraceRendererContext = createContext<{ renderer?: Renderer }>({});

export function useRendererInstance() {
  return useContext(TraceRendererContext);
}

function useRenderer(renderer?: string, { width, height }: Partial<Size> = {}) {
  const theme = useTheme();
  const renderers = useOne(slice.renderers);
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [error, setError] = useState("");
  const [instance, setInstance] = useState<Renderer>();

  useEffect(() => {
    if (ref && renderer) {
      const entry = find(renderers, (r) => r.renderer.meta.id === renderer);
      if (entry) {
        const instance = new entry.renderer.constructor();
        // `setup` is async — PIXI v8 builds its renderer, and so its canvas, in an async
        // `init` — so what used to be a thrown setup error is now a rejection, and the
        // effect can be torn down while setup is still in flight. `disposed` stops us
        // mounting a renderer nobody is waiting for any more, and `mounted` keeps the
        // teardown from trying to remove a view that was never appended.
        let disposed = false;
        let mounted = false;
        const ready = instance
          .setup({
            ...rendererOptions,
            screenSize: { width: 256, height: 256 },
            backgroundColor: theme.palette.background.paper,
            accentColor: theme.palette.primary.main,
          })
          .then(
            () => {
              if (disposed) return;
              ref.append(instance.getView()!);
              mounted = true;
              setInstance(instance);
              setError("");
            },
            (e) => {
              if (disposed) return;
              setError(`${entry.renderer.meta.name}: ${get(e, "message")}`);
              setInstance(undefined);
            },
          );
        return () => {
          disposed = true;
          setInstance(undefined);
          // Deferred until setup settles: destroying a half-initialised Application
          // throws, and until then there is nothing mounted to take down.
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
      }
    }
  }, [ref, theme.palette.primary.main, theme.palette.background.paper, renderer, renderers]);

  useDebounce(
    () => {
      if (instance && width && height) {
        instance.setOptions({ screenSize: { width, height } });
      }
    },
    theme.transitions.duration.standard,
    [instance, width, height],
  );
  return { instance, ref, error, setRef };
}

function useLoading() {
  return useOne(slice.loading, (l) => !!l.layers);
}

/**
 * Aggregate streaming status across all layers:
 * - "partial": some streaming trace is showing a preview ahead of its frontier
 *   (the current step isn't fully generated yet).
 * - "loading": something is generating, but what's shown is correct.
 * - "idle": nothing in flight.
 */
function useTraceStreamStatus(): "idle" | "loading" | "partial" {
  const oneShot = useLoading();
  return useOne(slice.layers, (layers) => {
    let loading = oneShot;
    let partial = false;
    for (const l of layers) {
      const stream = (l as any)?.source?.parsedTrace?.stream;
      if (stream && !stream.complete && !stream.error) {
        loading = true;
        if (((l as any)?.source?.step ?? 0) >= stream.frontier) partial = true;
      }
    }
    return partial ? "partial" : loading ? "loading" : "idle";
  });
}

function TraceRendererStatusBanner() {
  const status = useTraceStreamStatus();
  if (status === "idle") return null;
  const partial = status === "partial";
  return (
    <StatusBanner
      color={partial ? "warning" : "info"}
      label={partial ? "This is a partial preview, processing" : "Processing"}
    />
  );
}

const VIEWPORT_PAGE_DESCRIPTION = "When you create a layer, you'll see it visualised here.";

export function TraceRenderer({ width, height, renderer, rendererRef, layers }: RendererProps) {
  const key = useMemo(() => nanoid(), []);
  const { instance, error, setRef } = useRenderer(renderer, { width, height });

  const [selection, setSelection] = useState<SelectEvent>();

  useEffect(() => {
    if (instance) {
      const handleClick = (e: Event, e1: RendererEvent): void => {
        const e2 = e as MouseEvent;
        setSelection({
          client: { x: e2.clientX, y: e2.clientY },
          world: e1.world,
          info: { point: e1.world, components: e1.components },
        });
      };
      instance.on("click", handleClick);
      return () => void instance.off("click", handleClick);
    }
  }, [instance]);
  const context = useMemo(() => ({ renderer: instance }), [instance]);

  useEffect(() => rendererRef?.(instance), [instance, rendererRef]);

  useEffect(() => {
    const f = async () => await instance?.toDataUrl?.();
    slice.screenshots.set((s) => void (s[key] = f));
    return () => slice.screenshots.set((s) => void delete s[key]);
  }, [key, instance]);

  // Publish whether this mounted renderer drives the shared-store load() path,
  // so layer services (which mount outside this context) can skip generating the
  // legacy per-step components nothing would consume.
  useEffect(() => {
    if (!instance) return;
    slice.rendererCapabilities.mount(key, typeof instance.load === "function");
    return () => slice.rendererCapabilities.unmount(key);
  }, [key, instance]);

  return (
    <>
      <TraceRendererStatusBanner />
      <TraceRendererContext.Provider value={context}>
        <Box sx={{ width, height }}>
          {layers?.length ? (
            <TrustedContent>
              {error ? (
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    width,
                    height,
                    alignItems: "center",
                    justifyContent: "center",
                    color: (t) => t.palette.text.secondary,
                  }}
                >
                  <DisabledIcon sx={{ mb: 2 }} fontSize="large" />
                  {error}
                </Box>
              ) : (
                <Box
                  ref={setRef}
                  sx={{
                    "> canvas": { position: "absolute" },
                    animation: "fadeIn 75ms linear 450ms both",
                  }}
                >
                  {layers.map((l, i) => (
                    <RenderLayer index={i} key={l.key} layer={l} width={width} height={height} />
                  ))}
                </Box>
              )}
            </TrustedContent>
          ) : (
            <Placeholder
              icon={<ViewInArOutlined />}
              label="Viewport"
              sx={{ width, height }}
              secondary={VIEWPORT_PAGE_DESCRIPTION}
            />
          )}
        </Box>
      </TraceRendererContext.Provider>
      <SelectionMenu selection={selection} onClose={() => setSelection(undefined)} />
    </>
  );
}
