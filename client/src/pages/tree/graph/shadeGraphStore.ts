import interpolate from "color-interpolate";
import type { ColorRamp, LayerShading, SharedComponentStore } from "renderer";
import type { TraceEvent } from "protocol/Trace-v140";

/**
 * Recompute a graph layer's colour, without touching its geometry.
 *
 * Highlighting a path and colouring nodes by their `g` value are the same
 * operation: both rewrite `fill`/`ramp` and leave `x`/`y`/`size`/`pts` alone. So
 * both go through here, and both are cheap for the same reason — the spatial index
 * is derived from geometry, so it survives untouched. On a 717k-body graph this
 * writes ~3MB of columns rather than repacking 40MB and rebuilding an R-tree.
 *
 * The result is handed to `Renderer.setLayerShading`.
 */

const RAMP_STEPS = 16;
const FLOOR = 0.25;

/** Blue -> red, the sequential scale the old tracked-property colouring used. */
const SEQUENTIAL = [
  "#f7fbff",
  "#deebf7",
  "#c6dbef",
  "#9ecae1",
  "#6baed6",
  "#4292c6",
  "#2171b5",
  "#084594",
];

export type ShadeGraphStoreOptions = {
  /** The graph this shading is for. Read-only: only `count` is consulted. */
  geometry: Pick<SharedComponentStore, "count">;
  /** Bodies packed before the nodes; node body `i` is event `i - edgeCount`. */
  edgeCount: number;
  events?: TraceEvent[];

  /** Event type -> CSS colour. */
  colors: Record<string, string>;
  background: string;
  edgeColor: string;
  fadeWindow?: number;

  /**
   * Steps to highlight. When set, highlighted nodes take `highlightColor` flat and
   * everything else dims — the ramps are dropped entirely, because a focused view
   * is answering "which nodes are on this path", not "when was each one visited".
   */
  highlight?: number[];
  highlightColor?: string;

  /**
   * Colour nodes by this numeric event property instead of by event type. Also
   * drops the ramps: the question is "how big is `g` here", not "how recent".
   */
  trackedProperty?: string;

  generation: number;
};

function sab<T extends Uint8Array | Int32Array>(
  Ctor: new (b: SharedArrayBuffer) => T,
  bytes: number,
  length: number,
): T {
  return new Ctor(new SharedArrayBuffer(Math.max(1, length) * bytes));
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function shadeGraphStore({
  geometry,
  edgeCount,
  events = [],
  colors,
  background,
  edgeColor,
  fadeWindow = 400,
  highlight,
  highlightColor = "#00bcd4",
  trackedProperty,
  generation,
}: ShadeGraphStoreOptions): LayerShading {
  const { count } = geometry;
  const fill = sab(Int32Array, 4, count);
  const ramp = sab(Uint8Array, 1, count);
  const palette: string[] = [""];
  const ramps: ColorRamp[] = [];

  const edgeFill = palette.push(edgeColor) - 1;

  // A focused view or a property scale replaces the recency ramp rather than
  // layering on top of it. Two colour signals on one node is unreadable, and the
  // user asked a different question.
  const flat = !!highlight?.length || !!trackedProperty;

  if (!flat) {
    // Default: one ramp per event type, fading towards the background.
    const rampOf = new Map<string, number>();
    for (const type of new Set(events.map((e) => String(e.type ?? "")))) {
      const fade = interpolate([colors[type] ?? colors[""] ?? "#888888", background]);
      const offset = palette.length;
      for (let k = 0; k < RAMP_STEPS; k++) {
        palette.push(fade((k / (RAMP_STEPS - 1)) * (1 - FLOOR)));
      }
      ramps.push({ offset, length: RAMP_STEPS, window: fadeWindow });
      rampOf.set(type, ramps.length);
    }
    for (let b = 0; b < count; b++) {
      if (b < edgeCount) {
        fill[b] = edgeFill;
        continue;
      }
      const e = events[b - edgeCount];
      ramp[b] = rampOf.get(String(e?.type ?? "")) ?? 0;
    }
    return { fill, ramp, palette, ramps, generation };
  }

  if (highlight?.length) {
    // Dim everything, then repaint the path. `highlight` is a handful of steps out
    // of hundreds of thousands, so this is one O(n) fill plus an O(|path|) pass —
    // not a scan of the trace.
    const dim = palette.push(interpolate([colors[""] ?? "#888888", background])(0.85)) - 1;
    const hot = palette.push(highlightColor) - 1;
    fill.fill(dim);
    for (let b = 0; b < edgeCount; b++) fill[b] = edgeFill;
    for (const step of highlight) {
      const b = edgeCount + step;
      if (b >= edgeCount && b < count) fill[b] = hot;
    }
    return { fill, ramp, palette, ramps, generation };
  }

  // Colour by property: bucket its range over a sequential scale. Bodies whose
  // property is absent fall in the lowest bucket rather than vanishing.
  const scale = interpolate(SEQUENTIAL);
  const offset = palette.length;
  const BUCKETS = 32;
  for (let k = 0; k < BUCKETS; k++) palette.push(scale(k / (BUCKETS - 1)));

  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const v = num(e[trackedProperty!]);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || min === max) {
    min = 0;
    max = 1;
  }

  for (let b = 0; b < count; b++) {
    if (b < edgeCount) {
      fill[b] = edgeFill;
      continue;
    }
    const e = events[b - edgeCount];
    const t = (num(e?.[trackedProperty!]) - min) / (max - min);
    const k = Math.min(BUCKETS - 1, Math.max(0, Math.floor(t * BUCKETS)));
    fill[b] = offset + k;
  }
  return { fill, ramp, palette, ramps, generation };
}
