import { Renderer, RendererEvents, RendererOptions } from "renderer";
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
  animationDuration: number;
  debounceInterval: number;
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
  animationDuration: 150,
  debounceInterval: 1000 / 24,
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

export type D2RendererEvents = RendererEvents & {};

export type D2RendererInterface = Renderer<
  D2RendererOptions,
  D2RendererEvents,
  CompiledD2IntrinsicComponent
>;
