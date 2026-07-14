import { describe, expect, it } from "vitest";
import type { SharedComponentStore } from "renderer";
import {
  bodyBounds,
  buildIndex,
  hasSortedStarts,
  intersects,
  isAccumulable,
  isEphemeral,
  isPersistent,
  openIndex,
  startLowerBound,
  startUpperBound,
} from "../columnarIndex";

const f32 = (a: number[]) => {
  const t = new Float32Array(new SharedArrayBuffer(a.length * 4));
  t.set(a);
  return t;
};
const i32 = (a: number[]) => {
  const t = new Int32Array(new SharedArrayBuffer(a.length * 4));
  t.set(a);
  return t;
};

// rect@(0,0,10x10), circle@(100,100,r5), rect@(50,50,10x10)
function makeStore(): SharedComponentStore {
  const n = 3;
  const kind = new Uint8Array(new SharedArrayBuffer(n));
  kind.set([0, 1, 0]);
  return {
    generation: 1,
    count: n,
    total: 10,
    kind,
    x: f32([0, 100, 50]),
    y: f32([0, 100, 50]),
    size: f32([10, 5, 10]),
    size2: f32([10, 0, 10]),
    alpha: f32([1, 1, 1]),
    start: i32([0, 0, 0]),
    end: i32([10, 10, 10]),
    fill: i32([1, 1, 1]),
    palette: ["", "red"],
    label: i32([0, 0, 0]),
    strings: [""],
    ptOff: i32(new Array(n + 1).fill(0)),
    pts: f32([]),
  };
}

const sortNum = (a: number[]) => a.slice().sort((x, y) => x - y);

describe("columnarIndex", () => {
  const store = makeStore();

  it("computes bounding boxes per kind matching primitives.test", () => {
    expect(bodyBounds(store, 0)).toEqual([0, 0, 10, 10]); // rect
    expect(bodyBounds(store, 1)).toEqual([95, 95, 105, 105]); // circle
    expect(bodyBounds(store, 2)).toEqual([50, 50, 60, 60]); // rect
  });

  it("builds a SharedArrayBuffer-backed Flatbush that queries by store index", () => {
    const data = buildIndex(store)!;
    expect(data).toBeInstanceOf(SharedArrayBuffer);
    const fb = openIndex(data); // zero-copy reconstruct, as a worker would
    expect(sortNum(fb.search(0, 0, 20, 20))).toEqual([0]);
    expect(sortNum(fb.search(90, 90, 110, 110))).toEqual([1]);
    expect(sortNum(fb.search(-1, -1, 200, 200))).toEqual([0, 1, 2]);
    expect(sortNum(fb.search(500, 500, 600, 600))).toEqual([]);
  });

  it("returns undefined for an empty store (Flatbush requires >=1 item)", () => {
    expect(buildIndex({ ...store, count: 0 })).toBeUndefined();
  });

  // The index stores boxes as float32 to halve its memory, but `bodyBounds`
  // computes in float64 — and narrowing to the *nearest* float32 can nudge a min
  // up or a max down, shrinking the box until a body that grazes a tile edge is
  // no longer returned. Leaf boxes are therefore rounded strictly outward; this
  // is the test that would catch it if they weren't.
  it("never loses a body to float32 rounding: each is found by its own exact box", () => {
    const n = 64;
    const kind = new Uint8Array(new SharedArrayBuffer(n));
    // Coordinates chosen to be awkward in float32: thirds, tenths, big magnitudes.
    const xs = Array.from({ length: n }, (_, i) => (i % 2 ? i / 3 : i * 1234.5678) + 0.1);
    const ys = Array.from({ length: n }, (_, i) => (i % 3 ? i / 7 : i * 9876.5432) + 0.2);
    const sizes = Array.from({ length: n }, (_, i) => (i % 5) / 3 + 0.3);
    const awkward: SharedComponentStore = {
      ...store,
      count: n,
      kind, // all rects
      x: f32(xs),
      y: f32(ys),
      size: f32(sizes),
      size2: f32(sizes),
      alpha: f32(Array.from({ length: n }, () => 1)),
      start: i32(Array.from({ length: n }, () => 0)),
      end: i32(Array.from({ length: n }, () => 10)),
      fill: i32(Array.from({ length: n }, () => 1)),
      label: i32(Array.from({ length: n }, () => 0)),
      ptOff: i32(Array.from({ length: n + 1 }, () => 0)),
    };
    const fb = openIndex(buildIndex(awkward)!);
    for (let i = 0; i < n; i++) {
      const [minX, minY, maxX, maxY] = bodyBounds(awkward, i);
      expect(fb.search(minX, minY, maxX, maxY)).toContain(i);
      // ...and by a degenerate query exactly on its far corner.
      expect(fb.search(maxX, maxY, maxX, maxY)).toContain(i);
    }
  });
});

describe("accumulable layers", () => {
  /** `n` rects, body `i` opening at step `i` and never closing. */
  function makeTraceStore(n = 8): SharedComponentStore {
    const kind = new Uint8Array(new SharedArrayBuffer(n));
    return {
      ...makeStore(),
      count: n,
      total: n,
      kind,
      x: f32(Array.from({ length: n }, (_, i) => i)),
      y: f32(Array.from({ length: n }, () => 0)),
      size: f32(Array.from({ length: n }, () => 1)),
      size2: f32(Array.from({ length: n }, () => 1)),
      alpha: f32(Array.from({ length: n }, () => 1)),
      start: i32(Array.from({ length: n }, (_, i) => i)),
      end: i32(Array.from({ length: n }, () => n)),
      fill: i32(Array.from({ length: n }, () => 1)),
      label: i32(Array.from({ length: n }, () => 0)),
      ptOff: i32(new Array(n + 1).fill(0)),
    };
  }

  describe("isAccumulable", () => {
    it("accepts a trace: bodies open at their own step and never close", () => {
      expect(isAccumulable(makeTraceStore())).toBe(true);
    });

    it("accepts a map: every body open for the whole trace", () => {
      expect(isAccumulable(makeStore())).toBe(true);
    });

    it("accepts `clear` transients — they live for exactly one step", () => {
      // What the packer emits for `clear: true`: span [s, s+1).
      const store = makeTraceStore();
      store.end.set([1], 0); // body 0 opens at 0, closes at 1
      store.end.set([3], 2); // body 2 opens at 2, closes at 3
      expect(isEphemeral(store, 0)).toBe(true);
      expect(isPersistent(store, 0)).toBe(false);
      expect(isAccumulable(store)).toBe(true);
    });

    it("rejects a `clear: \"...\"` special that spans several steps", () => {
      // Born at 1, cleared at 5: persistent bodies born at 2..4 outrank it and
      // would have to be drawn *over* it, so it can neither be accumulated nor
      // composited on top. Falls back to the one-shot path.
      const store = makeTraceStore();
      store.start.set([1], 1);
      store.end.set([5], 1);
      expect(isEphemeral(store, 1)).toBe(false);
      expect(isPersistent(store, 1)).toBe(false);
      expect(isAccumulable(store)).toBe(false);
    });

    it("rejects a ramped store — its colours change under a fixed visible set", () => {
      const store = makeTraceStore();
      expect(
        isAccumulable({ ...store, ramps: [{ from: "red", to: "blue", over: 10 }] as never }),
      ).toBe(false);
    });
  });

  describe("hasSortedStarts", () => {
    it("holds for a store packed in event order", () => {
      expect(hasSortedStarts(makeTraceStore())).toBe(true);
    });

    it("fails when a body opens before its predecessor", () => {
      const store = makeTraceStore();
      store.start.set([5], 1); // body 1 opens at 5, body 2 still opens at 2
      expect(hasSortedStarts(store)).toBe(false);
    });
  });

  describe("startUpperBound", () => {
    const store = makeTraceStore(8);

    it("returns the size of the visible prefix", () => {
      // body i opens at step i, so at step s bodies 0..s are visible => s + 1
      for (let s = 0; s < 8; s++) expect(startUpperBound(store, s)).toBe(s + 1);
    });

    it("returns 0 before anything opens, and the count past the end", () => {
      expect(startUpperBound(store, -1)).toBe(0);
      expect(startUpperBound(store, 99)).toBe(store.count);
    });

    it("brackets exactly the bodies arriving in a step range", () => {
      // the arrivals in (2, 5] are bodies 3, 4, 5
      expect(startUpperBound(store, 2)).toBe(3);
      expect(startUpperBound(store, 5)).toBe(6);
    });

    it("with startLowerBound, brackets the bodies born at a step", () => {
      // the ephemerals alive at step s are exactly the bodies born at s
      for (let s = 0; s < 8; s++) {
        expect(startLowerBound(store, s)).toBe(s);
        expect(startUpperBound(store, s)).toBe(s + 1);
      }
    });
  });

  describe("intersects", () => {
    const store = makeStore(); // rect@(0,0,10x10), circle@(100,100,r5), rect@(50,50,10x10)

    it("agrees with the spatial index", () => {
      const bounds = { left: 45, top: 45, right: 60, bottom: 60 };
      expect(intersects(store, 2, bounds)).toBe(true);
      expect(intersects(store, 0, bounds)).toBe(false);
      expect(intersects(store, 1, bounds)).toBe(false);
    });

    it("counts a body grazing the edge as a hit", () => {
      expect(intersects(store, 0, { left: 10, top: 10, right: 20, bottom: 20 })).toBe(true);
    });
  });
});
