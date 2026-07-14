import { Renderer, RendererEvents, RendererOptions, SourceHandle } from "renderer";
import { CompiledD2IntrinsicComponent } from "./D2IntrinsicComponents";

export type Size = {
  width: number;
  height: number;
};

export type Point = {
  x: number;
  y: number;
};

/**
 * Under load, tiles are rasterized smaller and upscaled. `scale` divides the tile
 * resolution, so the *set of distinct tile sizes* is `tileResolution / scale` over
 * every scale this can reach.
 *
 * Keep that set tiny. Every distinct size is a separate entry in the workers'
 * per-layer raster cache (which is keyed by size), and a size the renderer visits
 * only occasionally is a cache slot that never pays for itself. The defaults below
 * make it strictly binary — full or half — by using an `increment` equal to the
 * whole `[minScale, maxScale]` range.
 */
type DynamicResolutionOptions = {
  /**
   * Turn the feedback loop off entirely, pinning tiles at `tileResolution`.
   *
   * **Both callers now set this.** Tile size is part of every cache key here, and it
   * is the one thing that forces a tile's GPU texture to be *reallocated* rather than
   * blitted into — so a ticker that flips it every 500ms under load is expensive in
   * three places at once. It clears the workers' tile caches (`setTileResolution`
   * does so outright), it re-rasterizes every visible tile, and it reallocates every
   * tile texture on the GPU. All of that, twice a second, for the whole of a scrub —
   * which is exactly the sustained load that trips it.
   *
   * The graph was always the clearer case: its colour ramps keep tiles stable between
   * bucket crossings, so the ticker was evicting precisely the cache the ramps exist
   * to keep warm. The viewport looked like it had less to lose, because it
   * re-rasterizes its trace layer every step regardless — but counting the GL calls
   * showed it paying ~150 full texture reallocations over a 12s scrub, all of it spent
   * to *lower* the resolution of a view that was not dropping frames.
   *
   * Left as an option rather than deleted: the loop is sound, and a genuinely
   * fill-rate-bound view (a huge dense map on a weak GPU) could still want it. But it
   * should be switched on deliberately, against a measurement, and not by default.
   */
  enabled?: boolean;
  intervalMs: number;
  increment: number;
  maxScale: number;
  minScale: number;
  dtMax: number;
  dtMin: number;
};

/**
 * One step of the dynamic-resolution feedback loop: given the current scale and
 * the average frame delta over the last interval, pick the next scale. Slow frames
 * (`adt >= dtMax`) scale up (smaller tiles); fast frames (`adt <= dtMin`) scale
 * back down; in between, hold — the gap between the two thresholds is the
 * hysteresis that stops it oscillating on every tick.
 */
export function nextResolutionScale(
  scale: number,
  adt: number,
  { dtMax, dtMin, increment, maxScale, minScale }: DynamicResolutionOptions,
): number {
  const next = adt >= dtMax ? scale + increment : adt <= dtMin ? scale - increment : scale;
  return Math.min(maxScale, Math.max(minScale, next));
}

export type D2RendererOptions = RendererOptions & {
  tileResolution: Size;
  tileSubdivision: number;
  workerCount: number;
  workerIndex: number;
  refreshInterval: number;
  /**
   * How many tile bitmaps may be handed to the GPU in one frame.
   *
   * A worker fleet under load can produce a whole frustum's worth of tiles at once,
   * and each one costs the *main* thread a texture upload — in the same frame budget
   * as the rest of the UI. Bounding it means a burst makes the viewport lag by a
   * frame or two rather than making the app stutter. Zero or less drains everything,
   * which is the old behaviour.
   *
   * Rarely binds in practice: with accumulating tiles only the tiles the search
   * frontier touched are dirty on a given step, and a frontier is spatially local.
   */
  maxTileUploadsPerFrame: number;
  animationDuration: number;
  debounceInterval: number;
  /**
   * Ease one wheel tick's zoom over this many milliseconds instead of applying the
   * whole scale multiplication in a single frame. 0 turns it off.
   *
   * Read once, when the viewport's plugins are installed — `setOptions` will not
   * change it on a live renderer.
   */
  zoomSmoothing: number;
  dynamicResolution: DynamicResolutionOptions;
};

export const defaultD2RendererOptions: D2RendererOptions = {
  screenSize: { width: 1, height: 1 },
  workerCount: 4,
  workerIndex: 0,
  tileResolution: {
    width: 64,
    height: 64,
  },
  tileSubdivision: 0,
  refreshInterval: 1000 / 24,
  maxTileUploadsPerFrame: 8,
  animationDuration: 150,
  debounceInterval: 1000 / 24,
  // Off, so the v1 and minimal renderers keep their instant wheel step. v2 opts in
  // (see `defaultZoomSmoothing`).
  zoomSmoothing: 0,
  errorColor: "#f44336",
  backgroundColor: "#ffffff",
  accentColor: "#333333",
  // Binary: full resolution or half, nothing in between. `increment` spans the
  // whole range, so `scale` is only ever exactly `minScale` or `maxScale` and the
  // renderer only ever produces two tile sizes. The previous 0.5 increment over
  // [1, 1.5] gave a third, awkward size (tile / 1.5) and let the loop drift
  // between them, which churns every size-keyed cache downstream for no gain.
  dynamicResolution: {
    intervalMs: 500,
    increment: 1,
    maxScale: 2,
    minScale: 1,
    dtMax: 1.5,
    dtMin: 1.1,
  },
};

/** A body under the pointer, as a (layer, body index) pair into its store. */
export type D2BodyHit = {
  handle: SourceHandle;
  index: number;
};

export type D2RendererEvents = RendererEvents & {
  /**
   * Columnar hit-test: the bodies under the pointer, topmost first.
   *
   * The inherited `click` event resolves against `D2RendererBase.system`, an rbush
   * populated by the v1 `add()` path — which v2 deliberately leaves inert, so
   * `click` fires on a v2 renderer with an empty component list and selection
   * silently does nothing. There is no per-body object to hand back here anyway:
   * v2 holds columns, not components. So it reports *indices*, and the consumer
   * (which packed the store, and therefore knows what body `i` means) maps them
   * back.
   */
  clickBody: (e: Event, hit: { world: Point; bodies: D2BodyHit[] }) => void;

  /**
   * A layer's spatial index has landed and it is now drawable.
   *
   * Packing the index is O(n log n) and happens in a worker, so `load()` returns
   * long before the layer has any bounds. Anything that needs those bounds —
   * `fitCamera` above all — must wait for this rather than guess at a delay: on a
   * large trace the guess loses, and the camera fits an empty renderer.
   */
  layerIndexed: (handle: SourceHandle) => void;
};

export type D2RendererInterface = Renderer<
  D2RendererOptions,
  D2RendererEvents,
  CompiledD2IntrinsicComponent
>;
