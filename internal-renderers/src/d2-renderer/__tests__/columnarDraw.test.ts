import { describe, expect, it, vi } from "vitest";
import type { SharedComponentStore } from "renderer";
import { columnarDrawTransform, drawBody, resolveFill } from "../columnarDraw";
import { buildIndex, openIndex, QueryScratch, queryVisible } from "../columnarIndex";

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

// rect@(0,0,10x10, red, span[0,10)), circle@(100,100,r5, blue, span[3,6))
function makeStore(): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(2));
  kind.set([0, 1]);
  return {
    generation: 7,
    count: 2,
    total: 10,
    kind,
    x: f32([0, 100]),
    y: f32([0, 100]),
    size: f32([10, 5]),
    size2: f32([10, 0]),
    alpha: f32([1, 0.5]),
    start: i32([0, 3]),
    end: i32([10, 6]),
    fill: i32([1, 2]),
    palette: ["", "red", "blue"],
    label: i32([0, 0]),
    strings: [""],
    ptOff: i32([0, 0, 0]),
    pts: f32([]),
  };
}

describe("columnarDrawTransform", () => {
  it("maps world bounds onto tile pixels", () => {
    expect(
      columnarDrawTransform(
        { top: 0, left: 0, right: 10, bottom: 10 },
        { width: 100, height: 100 },
      ),
    ).toEqual({
      sx: 10,
      sy: 10,
      x: 0,
      y: 0,
    });
  });
});

describe("drawBody", () => {
  it("draws a rect via fillRect at transformed, ceil'd coords", () => {
    const store = makeStore();
    const ctx = {
      fillStyle: "",
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
    };
    const t = columnarDrawTransform(
      { top: 0, left: 0, right: 10, bottom: 10 },
      { width: 100, height: 100 },
    );
    drawBody(store, 0, ctx as never, t, new Map());
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
    expect(ctx.ellipse).not.toHaveBeenCalled();
  });

  it("draws a circle via ellipse", () => {
    const store = makeStore();
    const ctx = {
      fillStyle: "",
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
    };
    const t = columnarDrawTransform(
      { top: 90, left: 90, right: 110, bottom: 110 },
      { width: 20, height: 20 },
    );
    drawBody(store, 1, ctx as never, t, new Map());
    expect(ctx.ellipse).toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("resolveFill", () => {
  it("memoizes per (paletteCode, quantized alpha)", () => {
    const store = makeStore();
    const cache = new Map<number, string>();
    const a = resolveFill(store, 1, 1, cache);
    const b = resolveFill(store, 1, 1, cache);
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });
});

describe("queryVisible", () => {
  const all = { top: -1, left: -1, right: 200, bottom: 200 };
  const ids = (a: Uint32Array) => [...a];

  it("intersects spatial hits with the [start,end) span at a step", () => {
    const store = makeStore();
    const fb = openIndex(buildIndex(store)!);
    expect(ids(queryVisible(store, fb, all, 0))).toEqual([0]); // circle not yet visible
    expect(ids(queryVisible(store, fb, all, 4))).toEqual([0, 1]); // both visible
    expect(ids(queryVisible(store, fb, all, 6))).toEqual([0]); // circle span ended
  });

  it("treats the span as half-open at both ends", () => {
    const store = makeStore(); // circle span is [3, 6)
    const fb = openIndex(buildIndex(store)!);
    expect(ids(queryVisible(store, fb, all, 2))).toEqual([0]);
    expect(ids(queryVisible(store, fb, all, 3))).toEqual([0, 1]); // start is inclusive
    expect(ids(queryVisible(store, fb, all, 5))).toEqual([0, 1]);
    expect(ids(queryVisible(store, fb, all, 6))).toEqual([0]); // end is exclusive
  });

  it("culls spatially, and returns empty off-content", () => {
    const store = makeStore();
    const fb = openIndex(buildIndex(store)!);
    expect(ids(queryVisible(store, fb, { top: 90, left: 90, right: 110, bottom: 110 }, 4))).toEqual(
      [1],
    );
    expect(
      ids(queryVisible(store, fb, { top: 500, left: 500, right: 600, bottom: 600 }, 4)),
    ).toEqual([]);
  });

  it("returns ascending ids, so draw order matches body index", () => {
    const store = makeStore();
    const fb = openIndex(buildIndex(store)!);
    const out = queryVisible(store, fb, all, 4);
    expect(ids(out)).toEqual([...ids(out)].sort((a, b) => a - b));
  });

  it("reuses a scratch buffer, and a second query invalidates the first's view", () => {
    const store = makeStore();
    const fb = openIndex(buildIndex(store)!);
    const scratch = new QueryScratch();
    const first = queryVisible(store, fb, all, 4, { scratch });
    expect(ids(first)).toEqual([0, 1]);
    // Same scratch → the earlier result is a stale view. This is why the tile
    // renderer keeps one scratch *per layer*: sharing one would make each layer
    // draw the next layer's bodies.
    const second = queryVisible(store, fb, all, 0, { scratch });
    expect(ids(second)).toEqual([0]);
    expect(first.buffer).toBe(second.buffer);
  });

  it("grows the scratch buffer past its initial capacity", () => {
    const n = 5000; // > the 1024 the scratch starts at
    const kind = new Uint8Array(new SharedArrayBuffer(n));
    const store: SharedComponentStore = {
      ...makeStore(),
      count: n,
      kind,
      x: f32(Array.from({ length: n }, (_, i) => i)),
      y: f32(Array.from({ length: n }, () => 0)),
      size: f32(Array.from({ length: n }, () => 1)),
      size2: f32(Array.from({ length: n }, () => 1)),
      alpha: f32(Array.from({ length: n }, () => 1)),
      start: i32(Array.from({ length: n }, () => 0)),
      end: i32(Array.from({ length: n }, () => 10)),
      fill: i32(Array.from({ length: n }, () => 1)),
      label: i32(Array.from({ length: n }, () => 0)),
      ptOff: i32(Array.from({ length: n + 1 }, () => 0)),
    };
    const fb = openIndex(buildIndex(store)!);
    const scratch = new QueryScratch();
    const out = queryVisible(store, fb, { top: -1, left: -1, right: n, bottom: 2 }, 5, { scratch });
    expect(out.length).toBe(n);
    expect(ids(out)).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});
