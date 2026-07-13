import { describe, expect, it, vi } from "vitest";
import type { SharedComponentStore } from "renderer";
import { packArrow, shadeOf } from "renderer";
import {
  buildLabelGrid,
  columnarDrawTransform,
  drawBody,
  pxSize,
  resolveFill,
} from "../columnarDraw";
import {
  buildIndex,
  isStepInvariant,
  openIndex,
  QueryScratch,
  queryVisible,
} from "../columnarIndex";
import { getFillStyle } from "../primitives";

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
    drawBody(store, 0, ctx as never, t, new Map(), { step: 0 });
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
    drawBody(store, 1, ctx as never, t, new Map(), { step: 0 });
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

// ---------------------------------------------------------------------------
// Screen-space sizing, LOD, arrows, ramps, inline labels, label thinning.

const u8 = (a: number[]) => {
  const t = new Uint8Array(new SharedArrayBuffer(a.length));
  t.set(a);
  return t;
};

const ctx2d = () => ({
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 0,
  lineCap: "",
  lineJoin: "",
  font: "",
  textAlign: "",
  textBaseline: "",
  fillRect: vi.fn(),
  beginPath: vi.fn(),
  ellipse: vi.fn(),
  fill: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  closePath: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
});

/** One circle of world radius `r` at the origin, in a 1:1 world→pixel tile. */
function circleStore(r: number, extra: Partial<SharedComponentStore> = {}): SharedComponentStore {
  return {
    generation: 0,
    count: 1,
    total: 10,
    kind: u8([1]),
    x: f32([0]),
    y: f32([0]),
    size: f32([r]),
    size2: f32([0]),
    alpha: f32([1]),
    start: i32([0]),
    end: i32([10]),
    fill: i32([1]),
    palette: ["", "red"],
    label: i32([0]),
    strings: [""],
    ptOff: i32([0, 0]),
    pts: f32([]),
    ...extra,
  };
}

const unit = columnarDrawTransform(
  { top: 0, left: 0, right: 100, bottom: 100 },
  {
    width: 100,
    height: 100,
  },
);

describe("pxSize", () => {
  it("scales with zoom by default (world space, unchanged behaviour)", () => {
    expect(pxSize(5, 4)).toBe(20);
  });
  it("ignores zoom under `screen`", () => {
    expect(pxSize(14, 4, { screen: true })).toBe(14);
  });
  it("clamps into the pixel range", () => {
    expect(pxSize(5, 0.01, { min: 2, max: 24 })).toBe(2);
    expect(pxSize(5, 100, { min: 2, max: 24 })).toBe(24);
    expect(pxSize(5, 2, { min: 2, max: 24 })).toBe(10);
  });
});

describe("drawBody: level of detail", () => {
  it("splats a sub-pixel circle with fillRect instead of an ellipse", () => {
    const store = circleStore(0.4);
    const ctx = ctx2d();
    drawBody(store, 0, ctx as never, unit, new Map(), { step: 0 });
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(ctx.ellipse).not.toHaveBeenCalled();
  });

  it("splats a small-but-visible circle too, as a rect of its diameter", () => {
    // The load-bearing case, and it is *not* the sub-pixel one. A 717k-point
    // scatter fitted to the viewport draws every node at ~2px — above a pixel, so
    // a sub-pixel-only splat would miss all of it and stroke 717k ellipses.
    const store = circleStore(2);
    const ctx = ctx2d();
    drawBody(store, 0, ctx as never, unit, new Map(), { step: 0 });
    expect(ctx.fillRect).toHaveBeenCalledWith(-2, -2, 4, 4);
    expect(ctx.ellipse).not.toHaveBeenCalled();
  });

  it("draws a real ellipse once a circle is big enough to read as round", () => {
    const store = circleStore(0.4);
    const ctx = ctx2d();
    drawBody(store, 0, ctx as never, unit, new Map(), {
      step: 0,
      sizing: { circle: { min: 4 } },
    });
    expect(ctx.ellipse).toHaveBeenCalledWith(0, 0, 4, 4, 0, 0, Math.PI * 2);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("drawBody: colour ramps", () => {
  // A ramp over palette[1..4), traversed across 90 steps.
  const ramped = () =>
    circleStore(5, {
      palette: ["", "#f00", "#888", "#111"],
      ramp: u8([1]),
      ramps: [{ offset: 1, length: 3, window: 90 }],
      start: i32([100]),
    });

  const shadeAt = (step: number) => {
    const store = ramped();
    const ctx = ctx2d();
    drawBody(store, 0, ctx as never, unit, new Map(), { step });
    return ctx.fillStyle;
  };

  it("walks the ramp with the body's age, then holds the last colour", () => {
    expect(shadeAt(100)).toBe(getFillStyle("#f00", 1)); // age 0   -> bucket 0
    expect(shadeAt(140)).toBe(getFillStyle("#888", 1)); // age 40  -> bucket 1
    expect(shadeAt(180)).toBe(getFillStyle("#111", 1)); // age 80  -> bucket 2
    expect(shadeAt(9999)).toBe(getFillStyle("#111", 1)); // saturated
  });

  it("shadeOf agrees with the draw path — the tile hash depends on it", () => {
    // If these two ever disagreed the content hash would be a lie and the tile
    // cache would serve a stale fade.
    const store = ramped();
    expect(shadeOf(store, 0, 100)).toBe(1);
    expect(shadeOf(store, 0, 140)).toBe(2);
    expect(shadeOf(store, 0, 9999)).toBe(3);
  });

  it("clamps ages before the body exists", () => {
    expect(shadeOf(ramped(), 0, 50)).toBe(1);
  });
});

describe("isStepInvariant", () => {
  it("is false for a ramped store even when every body is always visible", () => {
    // Visibility is step-independent here; colour is not. Caching the raster
    // would freeze the fade.
    const store = circleStore(5, {
      ramp: u8([1]),
      ramps: [{ offset: 1, length: 2, window: 10 }],
    });
    expect(isStepInvariant(store)).toBe(false);
    expect(isStepInvariant(circleStore(5))).toBe(true);
  });
});

describe("pxSize: CSS pixels vs tile pixels", () => {
  // A tile rasterizes into a bitmap that is stretched over its world bounds, so its
  // pixels are not CSS pixels — and `getTiles` snaps the tile's world size to a power
  // of two while the camera zooms continuously, so the ratio is not even constant.
  // Every screen-space quantity is therefore stated in CSS px and scaled here.
  it("scales the clamps by pixelScale", () => {
    // A world size that would land at 10 tile px, under a 24 CSS px ceiling.
    expect(pxSize(10, 1, { min: 3, max: 24 }, 1)).toBe(10);
    // At 4 tile px per CSS px, the same ceiling is 96 tile px — so 10 is untouched,
    // and the *floor* is now 12, which lifts it.
    expect(pxSize(10, 1, { min: 3, max: 24 }, 4)).toBe(12);
    // And a body that overshoots is capped at 24 CSS px, i.e. 96 tile px.
    expect(pxSize(1000, 1, { min: 3, max: 24 }, 4)).toBe(96);
  });

  it("scales a screen-space size by pixelScale, not by the world scale", () => {
    expect(pxSize(12, 999, { screen: true }, 4)).toBe(48); // 12 CSS px -> 48 tile px
  });

  it("defaults to 1, so a caller drawing straight to the screen is unaffected", () => {
    expect(pxSize(10, 1, { min: 3, max: 24 })).toBe(10);
    expect(pxSize(12, 999, { screen: true })).toBe(12);
  });
});

describe("pxSize: damping", () => {
  // Damping is a *multiplier* on the world size, not a bound on it. Below `from` a
  // body is drawn larger than world-space (so it does not vanish), above `to` smaller
  // (so it does not become a blob), and in between the growth is bent rather than
  // stopped — which is the thing a clamp cannot express, because a clamp pins.
  const damp = { from: 2, to: 32, fromScale: 2, toScale: 0.5 };
  const draw = (world: number) => pxSize(world, 1, { damp });

  it("scales up below the lower knee, and down above the upper one", () => {
    expect(draw(1)).toBeCloseTo(2, 5); // 1 * fromScale
    expect(draw(64)).toBeCloseTo(32, 5); // 64 * toScale
  });

  it("interpolates geometrically between the knees", () => {
    // Halfway in log space between 2 and 32 is 8; the scale there is the geometric
    // mean of 2 and 0.5, which is 1 — so the body draws at exactly its world size.
    expect(draw(8)).toBeCloseTo(8, 5);
  });

  it("never pins: the size keeps answering the camera", () => {
    // The failure a clamp has, stated as a test. Across the band, every doubling of
    // the world size still grows the body — just by less than double.
    for (const w of [2, 4, 8, 16]) {
      const growth = draw(w * 2) / draw(w);
      expect(growth).toBeGreaterThan(1);
      expect(growth).toBeLessThan(2);
    }
  });

  it("degenerates to world-space when both scales are 1", () => {
    const none = { from: 2, to: 32, fromScale: 1, toScale: 1 };
    for (const w of [1, 8, 64]) expect(pxSize(w, 1, { damp: none })).toBeCloseTo(w, 5);
  });

  it("is exactly screen-space when the scale ratio equals the size ratio", () => {
    // fromScale/toScale === to/from (16) => constant drawn size across the band.
    const flat = { from: 2, to: 32, fromScale: 4, toScale: 0.25 };
    const at = (w: number) => pxSize(w, 1, { damp: flat });
    expect(at(2)).toBeCloseTo(8, 5);
    expect(at(8)).toBeCloseTo(8, 5);
    expect(at(32)).toBeCloseTo(8, 5);
  });

  it("measures its knees in CSS pixels, like every other screen-space quantity", () => {
    // At 4 tile px per CSS px, a `from` of 2 CSS px is 8 tile px — so a body that is
    // 8 tile px is exactly at the knee, not four times past it.
    expect(pxSize(8, 1, { damp }, 4)).toBeCloseTo(16, 5); // 8 * fromScale
  });
});

describe("drawBody: arrowheads", () => {
  /** A 2-point path from (0,0) to (50,0), with `arrow` packed in. */
  const edge = (arrow: number, arrowSize = 10) =>
    ({
      generation: 0,
      count: 1,
      total: 10,
      kind: u8([2]),
      x: f32([0]),
      y: f32([0]),
      size: f32([1]),
      size2: f32([arrowSize]),
      alpha: f32([1]),
      start: i32([0]),
      end: i32([10]),
      fill: i32([1]),
      palette: ["", "red"],
      label: i32([0]),
      strings: [""],
      ptOff: i32([0, 2]),
      pts: f32([0, 0, 50, 0]),
      arrow: u8([arrow]),
    }) as SharedComponentStore;

  it("draws no head when the arrow column says none", () => {
    const ctx = ctx2d();
    drawBody(edge(packArrow(0, 0)), 0, ctx as never, unit, new Map(), { step: 0 });
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.closePath).not.toHaveBeenCalled(); // the head is the only closed path
  });

  it("draws a triangle at the terminal vertex, pointing along the last segment", () => {
    const ctx = ctx2d();
    drawBody(edge(packArrow(0, 1)), 0, ctx as never, unit, new Map(), { step: 0 });
    // Tip at the last point; base 10px back along +x; corners spread +/-5px on y.
    expect(ctx.moveTo).toHaveBeenCalledWith(50, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(40, 5);
    expect(ctx.lineTo).toHaveBeenCalledWith(40, -5);
    expect(ctx.closePath).toHaveBeenCalled();
  });

  it("draws a head at the first vertex too, pointing the other way", () => {
    const ctx = ctx2d();
    drawBody(edge(packArrow(1, 1)), 0, ctx as never, unit, new Map(), { step: 0 });
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(10, -5);
    expect(ctx.lineTo).toHaveBeenCalledWith(10, 5);
  });

  it("backs the head off by the radius of the node it points at", () => {
    // Without this the head is drawn *at* the terminal vertex — which in a graph is
    // the target node's centre — and nodes are packed after edges, so they paint
    // straight over it. The head is there; you just cannot see it.
    const s = { ...edge(packArrow(0, 1)), arrowInset: f32([10]) } as SharedComponentStore;
    const ctx = ctx2d();
    drawBody(s, 0, ctx as never, unit, new Map(), {
      step: 0,
      sizing: { circle: { min: 3, max: 24 } },
    });
    // Tip pulled 10px back from (50, 0); the head is still 10px long.
    expect(ctx.moveTo).toHaveBeenCalledWith(40, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(30, 5);
    expect(ctx.lineTo).toHaveBeenCalledWith(30, -5);
  });

  it("does not inset a body that asked for none, under a clamped circle policy", () => {
    // `pxSize(0, ...)` returns the circle policy's *minimum*, so reading the inset
    // unguarded would hand every head a 3px offset it never asked for.
    const ctx = ctx2d();
    drawBody(edge(packArrow(0, 1)), 0, ctx as never, unit, new Map(), {
      step: 0,
      sizing: { circle: { min: 3, max: 24 } },
    });
    expect(ctx.moveTo).toHaveBeenCalledWith(50, 0);
  });

  it("sizes the head in screen pixels, so zoom does not change it", () => {
    const zoomed = columnarDrawTransform(
      { top: 0, left: 0, right: 10, bottom: 10 },
      {
        width: 100,
        height: 100,
      },
    );
    const ctx = ctx2d();
    drawBody(edge(packArrow(0, 1)), 0, ctx as never, zoomed, new Map(), { step: 0 });
    // 10x zoom: the tip moves, but the head is still 10px long and 10px wide.
    expect(ctx.moveTo).toHaveBeenCalledWith(500, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(490, 5);
    expect(ctx.lineTo).toHaveBeenCalledWith(490, -5);
  });
});

describe("buildLabelGrid", () => {
  /** `n` labelled circles strung along y=0 at x = 0, 10, 20, ..., sizes 1..n. */
  function labelled(n: number): SharedComponentStore {
    return {
      generation: 0,
      count: n,
      total: 10,
      kind: u8(Array(n).fill(1)),
      x: f32(Array.from({ length: n }, (_, i) => i * 10)),
      y: f32(Array(n).fill(0)),
      size: f32(Array.from({ length: n }, (_, i) => i + 1)),
      size2: f32(Array(n).fill(0)),
      alpha: f32(Array(n).fill(1)),
      start: i32(Array(n).fill(0)),
      end: i32(Array(n).fill(10)),
      fill: i32(Array(n).fill(1)),
      palette: ["", "red"],
      label: i32(Array.from({ length: n }, (_, i) => i + 1)),
      strings: ["", ...Array.from({ length: n }, (_, i) => `n${i}`)],
      ptOff: i32(Array(n + 1).fill(0)),
      pts: f32([]),
    };
  }

  const tile = { width: 100, height: 100 };
  const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

  it("keeps the highest-`size` body per cell", () => {
    // 10 bodies at x = 0..90, cells 50px wide => two cells. Winners are the
    // largest in each: index 4 (x=40, size 5) and index 9 (x=90, size 10).
    const store = labelled(10);
    const won = buildLabelGrid(store, all(10), unit, tile, {
      grid: { width: 50, height: 100 },
    });
    expect([...won!].sort((a, b) => a - b)).toEqual([4, 9]);
  });

  it("draws every label when the cells are small enough to hold them", () => {
    // Zoom in (cells cover less world) and every body wins its own cell. This is
    // "more labels as you zoom in", and it needs no threshold.
    const store = labelled(10);
    const won = buildLabelGrid(store, all(10), unit, tile, {
      grid: { width: 10, height: 100 },
    });
    expect(won!.size).toBe(10);
  });

  it("thins against the visible set, not the store", () => {
    // The reason thinning is per-tile-per-step rather than a precomputed rank
    // column. Bodies 0 (x=0) and 5 (x=50) sit in different cells, so both keep
    // their labels — even though the store holds 10 bodies and body 5 would lose
    // its cell outright to body 9 if all ten were live.
    //
    // A precomputed rank would have thinned 0 and 5 against the *final* node set,
    // leaving step 100 of a million-node trace almost entirely unlabelled.
    const store = labelled(10);
    const live = Uint32Array.from([0, 5]);
    const won = buildLabelGrid(store, live, unit, tile, {
      grid: { width: 50, height: 100 },
    });
    expect([...won!].sort((a, b) => a - b)).toEqual([0, 5]);

    // Same two cells, all ten bodies live: the bigger neighbours take both.
    const crowded = buildLabelGrid(store, all(10), unit, tile, {
      grid: { width: 50, height: 100 },
    });
    expect([...crowded!].sort((a, b) => a - b)).toEqual([4, 9]);
  });

  it("is undefined without a grid, meaning draw every label", () => {
    expect(buildLabelGrid(labelled(3), all(3), unit, tile, {})).toBeUndefined();
  });
});

describe("drawBody: inline labels", () => {
  const store = () => circleStore(5, { label: i32([1]), strings: ["", "n42"] });

  it("draws the label clear of the body's edge, in screen pixels", () => {
    const ctx = ctx2d();
    drawBody(store(), 0, ctx as never, unit, new Map(), {
      step: 0,
      label: { size: 12, offset: 4, color: "#000" },
    });
    // Circle radius 5px at the origin; label sits at 5 + 4 = 9px to the right.
    expect(ctx.fillText).toHaveBeenCalledWith("n42", 9, 0);
    expect(ctx.font).toBe("12px Inter, Helvetica, Arial, sans-serif");
  });

  it("does not draw a label the grid thinned out", () => {
    const ctx = ctx2d();
    drawBody(store(), 0, ctx as never, unit, new Map(), {
      step: 0,
      label: { size: 12 },
      labels: new Set<number>(), // won nothing
    });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.ellipse).toHaveBeenCalled(); // the node itself still draws
  });

  it("draws nothing extra when the layer has no label policy", () => {
    const ctx = ctx2d();
    drawBody(store(), 0, ctx as never, unit, new Map(), { step: 0 });
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});
