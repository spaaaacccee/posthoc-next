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

/**
 * Build the shared Flatbush index for a store. Bodies are added in column order
 * so a query returns store indices directly. Returns `undefined` for an empty
 * store (Flatbush requires ≥1 item). The `.data` buffer is a SharedArrayBuffer
 * ready to hand to workers.
 */
export function buildIndex(store: SharedComponentStore): SharedArrayBuffer | undefined {
  if (store.count === 0) return undefined;
  const fb = new Flatbush(
    store.count,
    16,
    Float64Array,
    SharedArrayBuffer as unknown as ArrayBufferConstructor,
  );
  for (let i = 0; i < store.count; i++) {
    const [minX, minY, maxX, maxY] = bodyBounds(store, i);
    fb.add(minX, minY, maxX, maxY);
  }
  fb.finish();
  return fb.data as SharedArrayBuffer;
}

export function buildIndexedGeneration(store: SharedComponentStore): IndexedGeneration {
  return { store, index: buildIndex(store), generation: store.generation };
}

/** Reconstruct a Flatbush over a shared index buffer (zero-copy, per worker). */
export function openIndex(index: SharedArrayBuffer): Flatbush {
  return Flatbush.from(index);
}

export type QueryBounds = { top: number; left: number; right: number; bottom: number };

/**
 * Store indices of bodies overlapping `bounds` AND visible at `step`
 * (`start <= step < end`), sorted ascending so draw order matches the stable
 * body index. This is the render-time intersection of the spatial query and the
 * decoupled visibility span — O(candidates in tile), no global scan.
 */
export function queryVisible(
  store: SharedComponentStore,
  fb: Flatbush,
  bounds: QueryBounds,
  step: number,
): number[] {
  const hits = fb.search(bounds.left, bounds.top, bounds.right, bounds.bottom);
  const out: number[] = [];
  for (const i of hits) {
    if (store.start[i]! <= step && step < store.end[i]!) out.push(i);
  }
  out.sort((a, b) => a - b);
  return out;
}
