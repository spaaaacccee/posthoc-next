import Flatbush from "flatbush";
import type { SharedComponentStore } from "renderer";

/**
 * Renderer-owned geometry + spatial index over a {@link SharedComponentStore}.
 *
 * The store is renderer-agnostic (columns + spans, no bounding boxes). Here the
 * renderer derives a bbox per body — its geometry, matching `primitives[$].test`
 * — and packs a static Flatbush R-tree whose backing buffer is a
 * `SharedArrayBuffer`, so every render worker reconstructs it zero-copy with
 * `Flatbush.from(data)` instead of each building its own rbush.
 */

// Kind indices, matching COMPONENT_KINDS order in renderer/SharedComponentStore.
const RECT = 0;
const CIRCLE = 1;
const PATH = 2;
const POLYGON = 3;
const TEXT = 4;

/** Bounding box `[minX, minY, maxX, maxY]` for body `i` (mirrors primitives.test). */
export function bodyBounds(
  store: SharedComponentStore,
  i: number,
): [number, number, number, number] {
  const x = store.x[i]!;
  const y = store.y[i]!;
  const s = store.size[i]!;
  switch (store.kind[i]) {
    case CIRCLE:
      return [x - s, y - s, x + s, y + s];
    case PATH:
    case POLYGON: {
      const from = store.ptOff[i]! * 2;
      const to = store.ptOff[i + 1]! * 2;
      if (to <= from) return [0, 0, 0, 0];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let p = from; p < to; p += 2) {
        const px = store.pts[p]!;
        const py = store.pts[p + 1]!;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      if (store.kind[i] === PATH) {
        // Pad by line width + 1, matching primitives.path.test.
        const w = s + 1;
        return [minX - w, minY - w, maxX + w, maxY + w];
      }
      return [minX, minY, maxX, maxY];
    }
    case TEXT: {
      // Anchor at (x,y) baseline; extends up by font size (`s`) and right by the
      // estimated width (`size2`). A finite box so text is indexed/culled rather
      // than always-drawn — text near a tile edge may clip.
      const w = store.size2[i]!;
      return [x, y - s, x + w, y + s * 0.3];
    }
    case RECT:
    default: {
      // size = width, size2 = height; guard against negative extents.
      const s2 = store.size2[i]!;
      return [Math.min(x, x + s), Math.min(y, y + s2), Math.max(x, x + s), Math.max(y, y + s2)];
    }
  }
}

/** An immutable generation: the store + its shared spatial index. */
export type IndexedGeneration = {
  store: SharedComponentStore;
  /** Flatbush backing buffer (a SharedArrayBuffer); `undefined` when empty. */
  index?: SharedArrayBuffer;
  generation: number;
};

// The index stores boxes as float32 (half the memory and twice the cache density
// of float64, over a store whose coordinates are float32 anyway). But `bodyBounds`
// computes in float64, and narrowing rounds to the *nearest* float32 — which can
// nudge a `min` up or a `max` down and quietly shrink the box, dropping a body
// that grazes a tile edge. So leaf boxes are rounded strictly outward.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The float32 nearest `v` and `<= v`. */
function floorF32(v: number): number {
  f32[0] = v;
  const r = f32[0]!;
  if (r <= v || !Number.isFinite(r)) return r;
  // Rounded up: step one ulp toward -Infinity.
  u32[0] = u32[0]! + (r > 0 ? -1 : 1);
  return f32[0]!;
}

/** The float32 nearest `v` and `>= v`. */
function ceilF32(v: number): number {
  f32[0] = v;
  const r = f32[0]!;
  if (r >= v || !Number.isFinite(r)) return r;
  // Rounded down: step one ulp toward +Infinity.
  u32[0] = u32[0]! + (r >= 0 ? 1 : -1);
  return f32[0]!;
}

/**
 * Pack the Flatbush index for a store. Bodies are added in column order so a
 * query returns store indices directly. Returns `undefined` for an empty store
 * (Flatbush requires ≥1 item). The `.data` buffer is a SharedArrayBuffer ready
 * to hand to workers.
 *
 * This is O(n log n) with a `bodyBounds` per body — it is the expensive half of
 * loading a layer, and is deliberately *not* memoized, because it is meant to
 * run in a worker (see `D2RendererV2Worker.buildLayerIndex`). The main thread
 * memoizes the *result* via {@link cachedIndex}/{@link cacheIndex}.
 */
export function packIndex(store: SharedComponentStore): SharedArrayBuffer | undefined {
  if (store.count === 0) return undefined;
  const fb = new Flatbush(
    store.count,
    16,
    Float32Array,
    SharedArrayBuffer as unknown as ArrayBufferConstructor,
  );
  for (let i = 0; i < store.count; i++) {
    const [minX, minY, maxX, maxY] = bodyBounds(store, i);
    fb.add(floorF32(minX), floorF32(minY), ceilF32(maxX), ceilF32(maxY));
  }
  fb.finish();
  return fb.data as SharedArrayBuffer;
}

// A store is immutable, so its index is too. Re-`load()`ing the same (cached)
// store — e.g. every time the viewport remounts — should not rebuild it. This
// lives on the main thread, keyed by store identity: a store that crosses a
// `postMessage` arrives as a fresh wrapper object (the columns are shared, the
// wrapper is cloned), so a worker-side cache would never hit.
const indexCache = new WeakMap<SharedComponentStore, SharedArrayBuffer | undefined>();

/**
 * The memoized index for `store`, if it has been built before. `hit` is what
 * distinguishes "not built yet" from "built, and it's `undefined` because the
 * store is empty" — both of which have an `undefined` index.
 */
export function cachedIndex(store: SharedComponentStore): {
  hit: boolean;
  index?: SharedArrayBuffer;
} {
  return indexCache.has(store) ? { hit: true, index: indexCache.get(store) } : { hit: false };
}

export function cacheIndex(store: SharedComponentStore, index?: SharedArrayBuffer) {
  indexCache.set(store, index);
}

/** Pack-and-memoize, in one synchronous step. Prefer the async worker path. */
export function buildIndex(store: SharedComponentStore): SharedArrayBuffer | undefined {
  const cached = cachedIndex(store);
  if (cached.hit) return cached.index;
  const built = packIndex(store);
  cacheIndex(store, built);
  return built;
}

export function buildIndexedGeneration(store: SharedComponentStore): IndexedGeneration {
  return { store, index: buildIndex(store), generation: store.generation };
}

/** Reconstruct a Flatbush over a shared index buffer (zero-copy, per worker). */
export function openIndex(index: SharedArrayBuffer): Flatbush {
  return Flatbush.from(index);
}

/**
 * True when every body is visible at every step *and* shades the same at every
 * step, so this layer's contribution to any tile is **step-invariant** — the same
 * pixels at step 0 and step 10,000.
 *
 * Map layers are exactly this (`buildStaticComponentStore` gives every body the
 * span `[0, STATIC_END)`), and they are the reason it's worth asking: without it,
 * a map's walls are re-rasterized into every tile on every step, purely because
 * the trace layer sharing that tile changed. O(count), once per layer.
 *
 * A colour ramp disqualifies a layer outright, and cheaply: a ramped body's
 * *visibility* may well be step-independent while its *colour* is not, and
 * caching its raster would freeze the fade.
 */
export function isStepInvariant(store: SharedComponentStore): boolean {
  if (store.ramps?.length) return false;
  for (let i = 0; i < store.count; i++) {
    if (store.start[i]! > 0 || store.end[i]! < store.total) return false;
  }
  return true;
}

/**
 * A body that, once visible, stays visible for the rest of the trace. The packer
 * gives these the span `[birth, total)` — a search node that is expanded and
 * stays expanded. These are what a tile *accumulates*.
 */
export const isPersistent = (store: SharedComponentStore, i: number) =>
  store.end[i]! >= store.total;

/**
 * A body alive at exactly one step: `[s, s+1)`. Both a `clear: true` transient
 * and a `clear: "..."` special that happens to be cleared by the very next step
 * land here, and they are treated identically because they behave identically.
 *
 * These cannot be accumulated — they have to be un-drawn — so they are redrawn
 * every step. That is cheap, because only one step's worth is ever alive at once.
 */
export const isEphemeral = (store: SharedComponentStore, i: number) =>
  store.end[i]! === store.start[i]! + 1;

/**
 * True when this layer's tiles can be built by *accumulation*: drawn once and
 * then extended, rather than re-queried and redrawn from scratch on every step.
 *
 * Every body must be either {@link isPersistent} or {@link isEphemeral}, and the
 * layer must carry no colour ramp. Then a tile at step `s+1` is a tile at step
 * `s`, plus the persistent bodies that arrived, plus this step's ephemerals drawn
 * on top — and nothing that has been accumulated ever has to be un-drawn.
 *
 * **Why ephemerals may safely be drawn on top.** Bodies draw in ascending index
 * order, and the packer emits each step as `persistent, transient, special` (see
 * `buildSharedComponentStore`). So an ephemeral born at step `s` outranks every
 * persistent body born at steps `0..s` — and no persistent body born *after* `s`
 * is visible yet. It is therefore already above everything alive beneath it, and
 * compositing it last preserves the exact order a full redraw would produce.
 *
 * **What is excluded, and why it has to be.** A body with a span *wider* than one
 * step but narrower than the trace — a `clear: "..."` special cleared many steps
 * later — breaks that argument: persistent bodies born after it are visible, sort
 * above it, and would have to be drawn over it. Since it cannot be baked into the
 * accumulation canvas (it must eventually disappear) and cannot be drawn on top
 * (it would occlude bodies that outrank it), such a layer falls back to the
 * one-shot path. Correct, just not fast.
 *
 * Strictly weaker than {@link isStepInvariant}, which gets the better deal still:
 * its raster is drawn once and then never touched at all.
 */
export function isAccumulable(store: SharedComponentStore): boolean {
  if (store.ramps?.length) return false;
  for (let i = 0; i < store.count; i++) {
    if (isPersistent(store, i) || isEphemeral(store, i)) continue;
    return false;
  }
  return true;
}

/**
 * True when `start` is non-decreasing in body index — which it is whenever the
 * store was packed in event order, i.e. always, in practice.
 *
 * It means the bodies that become visible over a step range occupy a *contiguous*
 * index range, so the accumulator can find them with two binary searches rather
 * than an R-tree query. That matters more than it sounds: the Flatbush filter
 * visits every candidate box in the tile whatever the playhead is doing, so a
 * per-step query costs O(bodies ever in this tile) even when nothing new arrived.
 */
export function hasSortedStarts(store: SharedComponentStore): boolean {
  for (let i = 1; i < store.count; i++) if (store.start[i]! < store.start[i - 1]!) return false;
  return true;
}

/**
 * Index of the first body whose `start` is greater than `step` — the upper bound
 * of the visible prefix. Requires {@link hasSortedStarts}.
 */
export function startUpperBound(store: SharedComponentStore, step: number): number {
  let lo = 0;
  let hi = store.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (store.start[mid]! <= step) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the first body whose `start` is at or after `step`. With
 * {@link startUpperBound} this brackets the bodies *born at* `step` — which is
 * exactly the set of ephemerals alive there. Requires {@link hasSortedStarts}.
 */
export function startLowerBound(store: SharedComponentStore, step: number): number {
  let lo = 0;
  let hi = store.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (store.start[mid]! < step) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type QueryBounds = { top: number; left: number; right: number; bottom: number };

/** Whether body `i`'s bounding box overlaps `bounds`. */
export function intersects(store: SharedComponentStore, i: number, bounds: QueryBounds): boolean {
  const [minX, minY, maxX, maxY] = bodyBounds(store, i);
  return (
    maxX >= bounds.left && minX <= bounds.right && maxY >= bounds.top && minY <= bounds.bottom
  );
}

/**
 * A growable scratch buffer for {@link queryVisible} results.
 *
 * A query returns a *view* onto this buffer, so it is invalidated by the next
 * query against the same scratch. Anything holding several results live at once
 * (the tile renderer, which queries every layer before drawing any) needs one
 * scratch **per layer** — sharing one would silently make each layer draw the
 * next layer's bodies.
 */
export class QueryScratch {
  #buf = new Uint32Array(1024);
  take(n: number): Uint32Array {
    if (this.#buf.length < n) this.#buf = new Uint32Array(2 ** Math.ceil(Math.log2(n)));
    return this.#buf;
  }
}

export type QueryOptions = {
  /** Reusable output buffer. Omit to allocate a fresh one per call. */
  scratch?: QueryScratch;
  /** Sort ascending, so draw order matches body index. Skip it for hit-testing. */
  sort?: boolean;
};

/**
 * Store indices of bodies overlapping `bounds` AND visible at `step`
 * (`start <= step < end`), sorted ascending so draw order matches the stable
 * body index. This is the render-time intersection of the spatial query and the
 * decoupled visibility span — O(candidates in tile), no global scan.
 *
 * The step predicate is pushed into Flatbush's traversal filter, so bodies
 * outside the current span are rejected before they land in a result array. The
 * result is a `Uint32Array` sorted with the numeric typed-array sort: a tile can
 * hold hundreds of thousands of bodies, and a `number[]` with a comparator pays
 * a JS call per comparison.
 */
export function queryVisible(
  store: SharedComponentStore,
  fb: Flatbush,
  bounds: QueryBounds,
  step: number,
  { scratch, sort = true }: QueryOptions = {},
): Uint32Array {
  const hits = fb.search(
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    (i) => store.start[i]! <= step && step < store.end[i]!,
  );
  const n = hits.length;
  const buf = scratch ? scratch.take(n) : new Uint32Array(n);
  for (let k = 0; k < n; k++) buf[k] = hits[k]!;
  const out = buf.subarray(0, n);
  if (sort) out.sort();
  return out;
}
