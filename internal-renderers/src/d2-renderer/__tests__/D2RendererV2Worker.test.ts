import { defaultD2RendererOptions } from "d2-renderer/D2RendererOptions";
import { D2RendererV2Worker, D2V2WorkerEvent, tileCssSize } from "d2-renderer/D2RendererV2Worker";
import type { SharedComponentStore } from "renderer";
import { describe, expect, it, vi } from "vitest";

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

/**
 * Two rects, far apart so they land in different tiles. Both span the whole trace
 * (`[0, total)`), so this store is *step-invariant* — as a map layer's is.
 */
function makeStore(): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(2));
  kind.set([0, 0]);
  return {
    generation: 1,
    count: 2,
    total: 10,
    kind,
    x: f32([0, 300]),
    y: f32([0, 300]),
    size: f32([10, 10]),
    size2: f32([10, 10]),
    alpha: f32([1, 1]),
    start: i32([0, 0]),
    end: i32([10, 10]),
    fill: i32([1, 1]),
    palette: ["", "red"],
    label: i32([0, 0]),
    strings: [""],
    ptOff: i32([0, 0, 0]),
    pts: f32([]),
  };
}

/**
 * A step-invariant store dense enough to clear MIN_BODIES_TO_CACHE: a sparse
 * layer isn't worth caching (a full-tile blit costs more than drawing a few
 * rects), so only a dense one exercises the raster cache. All bodies sit in one
 * small region, so they land in the same tile.
 */
function makeDenseStore(n = 400): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(n)); // all rects
  const fill = (v: number) => Array.from({ length: n }, () => v);
  return {
    ...makeStore(),
    count: n,
    kind,
    x: f32(Array.from({ length: n }, (_, i) => (i % 20) * 2)),
    y: f32(Array.from({ length: n }, (_, i) => Math.floor(i / 20) * 2)),
    size: f32(fill(1)),
    size2: f32(fill(1)),
    alpha: f32(fill(1)),
    start: i32(fill(0)),
    end: i32(fill(10)),
    fill: i32(fill(1)),
    label: i32(fill(0)),
    ptOff: i32(Array.from({ length: n + 1 }, () => 0)),
  };
}

/** Same, but body 0 disappears at step 2 — so the layer is *not* step-invariant. */
function makeDynamicStore(): SharedComponentStore {
  const store = makeStore();
  store.end.set([2, 10]);
  return store;
}

/** Count `new OffscreenCanvas(...)` during `fn`. */
function countCanvases(fn: () => void): number {
  const Real = globalThis.OffscreenCanvas;
  let n = 0;
  class Counting extends Real {
    constructor(width: number, height: number) {
      super(width, height);
      n++;
    }
  }
  globalThis.OffscreenCanvas = Counting as unknown as typeof Real;
  try {
    fn();
  } finally {
    globalThis.OffscreenCanvas = Real;
  }
  return n;
}

function makeWorker(options: { workerCount?: number; workerIndex?: number } = {}) {
  const worker = new D2RendererV2Worker();
  worker.setup({ ...defaultD2RendererOptions, workerCount: 1, workerIndex: 0, ...options });
  worker.setFrustum({ top: 0, left: 0, bottom: 512, right: 512 });
  return worker;
}

/** Collect the `update` payloads a render emits. */
function capture(worker: D2RendererV2Worker) {
  const events: D2V2WorkerEvent[] = [];
  worker.on("message", (e) => events.push(e));
  return events;
}

const key = (b: { top: number; left: number }) => `${b.left},${b.top}`;
const updates = (events: D2V2WorkerEvent[]) => events.filter((e) => e.action === "update");

describe("D2RendererV2Worker", () => {
  describe("buildLayerIndex", () => {
    it("packs the index and hands it back, then the layer draws", () => {
      const worker = makeWorker();
      const events = capture(worker);
      const store = makeStore();

      // The main thread loads with no index — that work is ours now.
      worker.setLayer("a", { store, generation: store.generation });
      worker.render();
      expect(updates(events).some((e) => e.payload.bitmap)).toBe(true); // background only

      events.length = 0;
      worker.buildLayerIndex("a");

      const index = events.find((e) => e.action === "index");
      expect(index).toBeDefined();
      expect(index!.payload).toMatchObject({ handle: "a", generation: 1 });
      expect((index!.payload as { index?: SharedArrayBuffer }).index).toBeInstanceOf(
        SharedArrayBuffer,
      );
    });

    it("reports an empty store as an absent index rather than throwing", () => {
      const worker = makeWorker();
      const events = capture(worker);
      const store = { ...makeStore(), count: 0 };
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      const index = events.find((e) => e.action === "index");
      expect(index).toBeDefined();
      expect((index!.payload as { index?: SharedArrayBuffer }).index).toBeUndefined();
    });

    it("is a no-op for a layer that was unloaded while it was packing", () => {
      const worker = makeWorker();
      capture(worker);
      expect(() => worker.buildLayerIndex("gone")).not.toThrow();
    });
  });

  describe("setStep", () => {
    // Ownership used to rotate on every step (`#now++`), so a scrub handed each
    // tile to a different worker and the content-hash cache below was always
    // consulted by a worker that had never rendered that tile.
    it("keeps tile ownership fixed across a step change", () => {
      const worker = makeWorker({ workerCount: 4, workerIndex: 1 });
      const store = makeStore();
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");

      const before = capture(worker);
      worker.render();
      const ownedAtStep0 = updates(before).map((e) => key(e.payload.bounds));
      expect(ownedAtStep0.length).toBeGreaterThan(0);

      const after = capture(worker);
      worker.setStep(1);
      worker.render();
      const ownedAtStep1 = updates(after).map((e) => key(e.payload.bounds));

      expect([...ownedAtStep1].sort()).toEqual([...ownedAtStep0].sort());
    });

    it("does not re-rasterize a tile whose content is unchanged at the new step", () => {
      const worker = makeWorker();
      const store = makeStore(); // every body spans [0, 10) — steps 0..9 look identical
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      worker.render();

      const events = capture(worker);
      worker.setStep(1);
      worker.render();

      const out = updates(events);
      expect(out.length).toBeGreaterThan(0);
      // Every tile resolves, but none ships a new bitmap: same content, cache hit.
      expect(out.every((e) => !e.payload.bitmap)).toBe(true);
    });

    it("does re-rasterize when the step actually changes what is visible", () => {
      const worker = makeWorker();
      const store = makeStore();
      store.end.set([2, 10]); // body 0 disappears at step 2
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      worker.render();

      const events = capture(worker);
      worker.setStep(5);
      worker.render();

      expect(updates(events).some((e) => e.payload.bitmap)).toBe(true);
    });
  });

  describe("setFrustum", () => {
    // The scale screen-space sizes resolve through is part of a tile's content hash,
    // so where it comes from decides what a zoom costs. Taken from the *camera* it
    // slides continuously, and every tile in the frustum re-rasterizes and re-ships for
    // the length of the gesture — which is a zoom that visibly churns. Taken from the
    // tile grid (see `tileCssSize`) it does not move at all, and a zoom within an
    // octave is free: the tiles are already right, and the GPU just scales the sprites.
    it("re-rasterizes nothing when a zoom lands on the same tiles", () => {
      const options = {
        ...defaultD2RendererOptions,
        workerCount: 1,
        workerIndex: 0,
        tileSubdivision: 2,
        tileResolution: { width: 256, height: 256 },
        screenSize: { width: 1024, height: 1024 },
      };
      const worker = new D2RendererV2Worker();
      worker.setup(options);

      // Two frustums an octave apart in *size* but not in tiling: `getTiles` snaps a
      // tile's world size to a power of two, so both cut the world into 128-unit tiles
      // and the closer view's tiles are a subset of the wider one's — same bounds, same
      // bodies, same pixels.
      const wide = { top: 0, left: 0, bottom: 1000, right: 1000 };
      const close = { top: 0, left: 0, bottom: 600, right: 600 };
      const scale = tileCssSize(options); // what the renderer sends, at every zoom

      const store = makeStore();
      worker.setFrustum(wide, scale);
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      worker.render();

      const events = capture(worker);
      worker.setFrustum(close, scale);
      worker.render();

      const out = updates(events);
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((e) => !e.payload.bitmap)).toBe(true);
    });
  });

  // The tile cache records what the *main thread* holds, not what this worker
  // rasterized — that is why a hit ships a hash and no bitmap. The main thread
  // evicts tiles (TILE_BUDGET), so it can lose one the worker still believes it
  // has, and every render then agrees the content is unchanged and declines to
  // send it: a placeholder that no amount of panning heals, only a scrub.
  describe("dropTiles", () => {
    it("re-sends a tile the main thread evicted, though its content never changed", () => {
      const worker = makeWorker();
      const store = makeStore(); // invariant: the same content at every step
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      const first = capture(worker);
      worker.render();

      const evicted = updates(first).find((e) => e.payload.bitmap)!.payload.bounds;

      // Baseline: unchanged content, so the worker declines to re-send it.
      const before = capture(worker);
      worker.render();
      expect(updates(before).find((e) => key(e.payload.bounds) === key(evicted))?.bitmap).toBe(
        undefined,
      );

      // The main thread evicted it and said so — now it must come back.
      const after = capture(worker);
      worker.dropTiles([evicted]);
      worker.render();
      const resent = updates(after).find((e) => key(e.payload.bounds) === key(evicted));
      expect(resent?.payload.bitmap).toBeDefined();
    });

    it("renders on its own, without waiting for the next camera move", async () => {
      vi.useFakeTimers();
      try {
        const settle = () =>
          vi.advanceTimersByTimeAsync(defaultD2RendererOptions.refreshInterval * 2);
        const worker = makeWorker();
        const store = makeStore();
        const events = capture(worker);
        worker.setLayer("a", { store, generation: store.generation });
        worker.buildLayerIndex("a");
        await settle(); // let the renders that loading scheduled land, and cache their tiles

        const evicted = updates(events).find((e) => e.payload.bitmap)!.payload.bounds;
        events.length = 0;
        await settle();
        expect(events).toHaveLength(0); // quiescent: nothing is pending

        worker.dropTiles([evicted]);
        // No render() call. An eviction is acknowledged *after* the pan that caused
        // it, so a worker that only re-rasterized on the next frustum change would
        // leave the hole on screen until the user happened to move the camera again.
        await settle();

        expect(updates(events).some((e) => key(e.payload.bounds) === key(evicted))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores tiles it never rendered", () => {
      const worker = makeWorker();
      const store = makeStore();
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      worker.render();
      const cached = worker.cacheSize;
      expect(cached).toBeGreaterThan(0);

      // Bounds belonging to another worker's stride, or to no tile at all.
      worker.dropTiles([{ top: -1e6, left: -1e6, bottom: -1e6 + 1, right: -1e6 + 1 }]);
      expect(worker.cacheSize).toBe(cached);
    });
  });

  describe("setLayerParams", () => {
    it("drops the tile cache and the memoized draw order", () => {
      const worker = makeWorker();
      const store = makeStore();
      worker.setLayer("a", { store, generation: store.generation }, { index: 0 });
      worker.buildLayerIndex("a");
      capture(worker);
      worker.render();
      expect(worker.cacheSize).toBeGreaterThan(0);

      worker.setLayerParams("a", { index: 2 });
      expect(worker.cacheSize).toBe(0);

      // ...and the next render repaints rather than serving stale tiles.
      const events = capture(worker);
      worker.render();
      expect(updates(events).some((e) => e.payload.bitmap)).toBe(true);
    });
  });

  it("reuses two pooled surfaces rather than allocating a canvas per tile", () => {
    const worker = makeWorker();
    const store = makeDynamicStore(); // dynamic: no per-layer raster cache to allocate
    worker.setLayer("a", { store, generation: store.generation });
    worker.buildLayerIndex("a");
    capture(worker);

    const allocations = countCanvases(() => {
      worker.render(); // many tiles
      worker.setStep(3);
      worker.render();
      worker.setStep(7);
      worker.render();
    });
    // Output + layer scratch, for the life of the worker — not two per tile per
    // render, which is what this used to be.
    expect(allocations).toBeLessThanOrEqual(2);
  });

  // A map layer's bodies span the whole trace, so its pixels in a given tile are
  // identical at step 0 and step 10,000. Without this cache, its walls were
  // re-rasterized into every tile on every step, purely because the trace layer
  // sharing that tile had changed.
  describe("step-invariant layer raster cache", () => {
    it("rasterizes an invariant layer once per tile, then reuses it across steps", () => {
      const worker = makeWorker();
      const store = makeDenseStore(); // invariant AND dense enough to be worth caching
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      capture(worker);

      const first = countCanvases(() => worker.render());
      expect(worker.layerTileCacheSize).toBeGreaterThan(0);
      expect(first).toBeGreaterThan(2); // 2 pooled + one per tile holding content

      // Every later step composites from those cached rasters — no new canvas,
      // no re-query, no re-rasterize.
      const later = countCanvases(() => {
        worker.setStep(3);
        worker.render();
        worker.setStep(8);
        worker.render();
      });
      expect(later).toBe(0);
    });

    it("does not cache a layer whose bodies come and go", () => {
      const worker = makeWorker();
      const store = makeDynamicStore();
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      capture(worker);
      worker.render();
      expect(worker.layerTileCacheSize).toBe(0);
    });

    // A blit of a whole tile costs more than drawing a couple of rects, so a
    // sparse invariant layer is deliberately left uncached — caching it would
    // trade cheap draws for an expensive drawImage plus a megabyte of canvas.
    it("does not allocate a raster for a sparse invariant layer", () => {
      const worker = makeWorker();
      const store = makeStore(); // invariant, but only 2 bodies
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      capture(worker);

      const allocations = countCanvases(() => worker.render());
      expect(allocations).toBeLessThanOrEqual(2); // the pooled surfaces only
    });

    it("survives a compositing-param change — alpha applies at composite time", () => {
      const worker = makeWorker();
      const store = makeDenseStore();
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      capture(worker);
      worker.render();
      const cached = worker.layerTileCacheSize;
      expect(cached).toBeGreaterThan(0);

      worker.setLayerParams("a", { alpha: 0.5 });
      expect(worker.layerTileCacheSize).toBe(cached); // the raster is unchanged...
      expect(worker.cacheSize).toBe(0); // ...but the composited tiles are stale

      const allocations = countCanvases(() => worker.render());
      expect(allocations).toBe(0); // re-composited straight from cache
    });

    // The dynamic-resolution ticker flips the tile size every 500ms under load
    // (scale oscillates between minScale and maxScale). Dropping the rasters on
    // each flip re-rasterized every invariant layer into a fresh canvas twice a
    // second — worse than no cache at all, and it pegged the CPU in the real app.
    // Size is part of the key instead, so the sizes it cycles between stay warm.
    it("keeps rasters warm across the tile sizes dynamic resolution cycles through", () => {
      const worker = makeWorker();
      const store = makeDenseStore();
      worker.setLayer("a", { store, generation: store.generation });
      worker.buildLayerIndex("a");
      capture(worker);

      const A = { width: 64, height: 64 };
      const B = { width: 96, height: 96 };
      worker.setTileResolution(A);
      worker.render();
      worker.setTileResolution(B);
      worker.render();
      const warm = worker.layerTileCacheSize;
      expect(warm).toBeGreaterThan(0);

      // Flip back and forth: both sizes are already cached, so no re-rasterizing.
      const allocations = countCanvases(() => {
        worker.setTileResolution(A);
        worker.render();
        worker.setTileResolution(B);
        worker.render();
      });
      // The only allocations are the two pooled surfaces being resized on each
      // flip (2 surfaces x 2 flips). Crucially, not one tile raster is rebuilt.
      expect(allocations).toBeLessThanOrEqual(4);
      expect(worker.layerTileCacheSize).toBe(warm);
    });
  });
});

/**
 * One ramped circle: born at step 10, fading across 3 colours over 100 steps.
 * Every body is always visible, so *visibility* is step-invariant — only the
 * colour moves.
 */
function makeRampedStore(): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(1));
  kind.set([1]); // circle
  const ramp = new Uint8Array(new SharedArrayBuffer(1));
  ramp.set([1]);
  return {
    generation: 1,
    count: 1,
    total: 10_000,
    kind,
    x: f32([10]),
    y: f32([10]),
    size: f32([5]),
    size2: f32([0]),
    alpha: f32([1]),
    start: i32([10]),
    end: i32([10_000]),
    fill: i32([1]),
    palette: ["", "#f00", "#888", "#111"],
    label: i32([0]),
    strings: [""],
    ptOff: i32([0, 0]),
    pts: f32([]),
    ramp,
    ramps: [{ offset: 1, length: 3, window: 100 }],
  };
}

/** Tiles this render actually re-rasterized (a hash-only update is a cache hit). */
const repainted = (events: D2V2WorkerEvent[]) => updates(events).filter((e) => e.payload.bitmap);

describe("colour ramps", () => {
  function rampedWorker() {
    const worker = makeWorker();
    const store = makeRampedStore();
    worker.setLayer("a", { store, generation: store.generation });
    worker.buildLayerIndex("a");
    return worker;
  }

  it("repaints only when a body crosses a ramp bucket, not on every step", () => {
    // This is the invariant the whole ramp design rests on. The tile hash folds
    // each ramped body's *bucket*, not the raw step — so advancing the playhead
    // within a bucket changes nothing and the tile stays cached. Folding the step
    // itself would be correct but would repaint every tile on every step, which
    // is precisely the thing being replaced.
    const worker = rampedWorker();
    const events = capture(worker);

    worker.setStep(10);
    worker.render();
    expect(repainted(events).length).toBeGreaterThan(0); // first paint

    events.length = 0;
    worker.setStep(11); // age 0 -> 1: still bucket 0
    worker.render();
    expect(repainted(events)).toHaveLength(0);

    events.length = 0;
    worker.setStep(50); // age 40: bucket 1
    worker.render();
    expect(repainted(events)).toHaveLength(1);
  });

  it("stops repainting once a tile's ramps have saturated", () => {
    // The payoff: an old, fully-faded region of the graph costs nothing to scrub
    // past, however far the playhead moves. Only tiles near the search frontier
    // re-rasterize — and a frontier is spatially local, which is why this beats
    // sigma's recolour-everything-every-step.
    const worker = rampedWorker();
    const events = capture(worker);

    worker.setStep(500); // long past the 100-step window
    worker.render();
    expect(repainted(events).length).toBeGreaterThan(0);

    events.length = 0;
    worker.setStep(9_999); // still saturated: same bucket, same hash
    worker.render();
    expect(repainted(events)).toHaveLength(0);
  });

  it("never caches a ramped layer's raster, even though its bodies never move", () => {
    // `isStepInvariant` must reject a ramped store: caching its raster would
    // freeze the fade at whatever step it was first drawn.
    const worker = rampedWorker();
    worker.setStep(20);
    worker.render();
    expect(worker.layerTileCacheSize).toBe(0);
  });
});

/**
 * A trace: `n` bodies packed in event order, body `i` opening at step `i` and
 * never closing. All of them sit in one small region, so they land in the same
 * tile — which is what a search frontier does, and what makes the per-tile cost
 * worth caring about.
 */
function makeTraceStore(n = 120): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(n)); // all rects
  const fill = <T,>(v: T) => Array.from({ length: n }, () => v);
  return {
    ...makeStore(),
    count: n,
    total: n,
    kind,
    x: f32(Array.from({ length: n }, (_, i) => (i % 10) * 2)),
    y: f32(Array.from({ length: n }, (_, i) => Math.floor(i / 10) * 2)),
    size: f32(fill(1)),
    size2: f32(fill(1)),
    alpha: f32(fill(1)),
    start: i32(Array.from({ length: n }, (_, i) => i)), // opens at its own step
    end: i32(fill(n)), // never closes
    fill: i32(fill(1)),
    label: i32(fill(0)),
    ptOff: i32(new Array(n + 1).fill(0)),
  };
}

/** Count `fillRect` calls — one per rect body drawn — during `fn`. */
function countFillRects(fn: () => void): number {
  const proto = Object.getPrototypeOf(
    document.createElement("canvas").getContext("2d")!,
  ) as CanvasRenderingContext2D;
  const spy = vi.spyOn(proto, "fillRect");
  try {
    fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

/** Play the playhead from 0 to `n - 1`, rendering every step. */
function play(worker: D2RendererV2Worker, n: number) {
  for (let s = 0; s < n; s++) {
    worker.setStep(s);
    worker.render();
  }
}

describe("accumulation", () => {
  const N = 120;

  function loaded(store: SharedComponentStore) {
    const worker = makeWorker();
    worker.setLayer("a", { store, generation: store.generation });
    worker.buildLayerIndex("a"); // packs + attaches the index
    return worker;
  }

  it("draws each body once over a whole playback, not once per step", () => {
    // The bug this pins: a trace layer is not step-invariant, so every step used
    // to re-query its tile and redraw *every body accumulated so far* in order to
    // add one. That is O(step) per frame — quadratic over a playback — and it is
    // why a long trace played slower the further in you got.
    const accumulating = countFillRects(() => play(loaded(makeTraceStore(N)), N));

    // Control: the same trace, but body 0 lives from step 0 to step 60 — a span
    // wider than one step and narrower than the trace, i.e. a `clear: "..."`
    // special. Persistent bodies born after it outrank it, so it can be neither
    // accumulated nor composited on top, and the layer falls back to the one-shot
    // path. (A one-step `clear: true` transient would *not* work as a control:
    // that is an ephemeral, and the layer still accumulates. See `isAccumulable`.)
    const spanning = makeTraceStore(N);
    spanning.end.set([60], 0);
    const redrawing = countFillRects(() => play(loaded(spanning), N));

    // Assert the *shape*, not a ratio — the ratio grows with N, so pinning it
    // would just be pinning this test's N.
    //
    // Redrawing pays a triangular number of body draws (~N²/2). Accumulating pays
    // each body exactly once, plus a background + notch fill per tile per emitted
    // step, which is why this is a bound rather than `=== N`.
    expect(redrawing).toBeGreaterThan((N * N) / 4);
    expect(accumulating).toBeGreaterThanOrEqual(N);
    expect(accumulating).toBeLessThan(N * 5);
  });

  it("emits no bitmap for a step that brings nothing new into the tile", () => {
    // Bodies only open on even steps, so an odd step changes nothing.
    const store = makeTraceStore(N);
    store.start.set(Array.from({ length: N }, (_, i) => i * 2));
    store.total = N * 2;
    store.end.set(Array.from({ length: N }, () => N * 2));

    const worker = loaded(store);
    const events = capture(worker);

    worker.setStep(10); // even: body 5 has just arrived
    worker.render();
    expect(updates(events).some((e) => e.payload.bitmap)).toBe(true);

    events.length = 0;
    worker.setStep(11); // odd: nothing arrives
    worker.render();
    expect(updates(events).some((e) => e.payload.bitmap)).toBe(false);
  });

  it("redraws from scratch when the playhead is scrubbed backwards", () => {
    // An accumulation canvas can add bodies but never un-draw them, so going
    // back has to start over — otherwise the tile would show the future.
    const worker = loaded(makeTraceStore(N));
    worker.setStep(N - 1);
    worker.render();

    // Back to step 5: only bodies 0..5 may be on the tile, so the canvas is
    // rebuilt — which we can see as a fresh burst of draws.
    const onScrubBack = countFillRects(() => {
      worker.setStep(5);
      worker.render();
    });
    expect(onScrubBack).toBeGreaterThanOrEqual(6);

    // ...and it is a *rebuild*, not an append: the 114 bodies that opened after
    // step 5 are not drawn again.
    expect(onScrubBack).toBeLessThan(N / 2);
  });
});
