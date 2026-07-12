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
import { graphLayerParams } from "./buildGraphStore";

/**
 * The graph's own renderer instance, deliberately not the viewport's.
 *
 * Two of its settings are wrong for a map and right here, which is the whole
 * reason it isn't shared:
 *
 * **Tiles subdivide harder.** Tiles are striped across workers one-for-one, so a
 * tile's body count *is* a worker's share of the frame — and search data is
 * heavily clustered. On a real 717k-event trace, the viewport's `tileSubdivision:
 * 2` leaves one worker holding ~32% of every frame; at 3 it is 14%, at 4 it is 6%.
 * A map's bodies are spread evenly over its grid and never had this problem.
 *
 * **Dynamic resolution is off.** The ticker halves tile size under load, and
 * `setTileResolution` clears the tile cache outright. A graph's tiles are cached
 * against a content hash and stay valid between ramp-bucket crossings — that cache
 * is the entire reason a scrub is cheap — so a ticker evicting it twice a second
 * would undo the design. The map re-rasterizes its trace layer every step anyway,
 * so it has far less to lose and keeps the feature.
 */
const TILE_RESOLUTION = 128;

const tile = devicePixelRatio * 2 * TILE_RESOLUTION * (isMobile ? 0.25 : 1);

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
  ghostAlpha = 0.4,
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
  const labelColor = theme.palette.text.secondary;

  useEffect(() => {
    if (!ref) return;
    const instance = new D2RendererV2();
    instance.setup({
      ...rendererOptions,
      screenSize: { width: 256, height: 256 },
      backgroundColor: background,
      accentColor: accent,
    });
    ref.append(instance.getView()!);
    setRenderer(instance);
    return () => {
      try {
        ref.removeChild(instance.getView()!);
      } catch (e) {
        console.warn(e);
      }
      setRenderer(undefined);
      instance.destroy();
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
          ...graphLayerParams(labelColor, graph.mode),
          label: undefined,
          index: 0,
          alpha: ghostAlphaRef.current,
        })
      : undefined;
    const h = renderer.load(graph.store, {
      ...graphLayerParams(labelColor, graph.mode),
      index: 1,
    });
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
  }, [renderer, graph, labelColor]);

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
