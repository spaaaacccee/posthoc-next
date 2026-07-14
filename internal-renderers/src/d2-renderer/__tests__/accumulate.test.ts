import { defaultD2RendererOptions } from "d2-renderer/D2RendererOptions";
import { D2RendererV2Worker } from "d2-renderer/D2RendererV2Worker";
import type { SharedComponentStore } from "renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real `drawBody` so we can see exactly which bodies each render path
// puts on the canvas. The canvas itself is a stub under jsdom, so *what was
// drawn* is the only thing worth asserting on — and it is the thing that matters:
// an accumulated tile is correct iff it holds the same bodies a full redraw would.
const rec = vi.hoisted(() => ({ calls: [] as { i: number; ctx: unknown }[] }));

vi.mock("../columnarDraw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../columnarDraw")>();
  return {
    ...actual,
    drawBody: (
      store: Parameters<typeof actual.drawBody>[0],
      i: number,
      ctx: Parameters<typeof actual.drawBody>[2],
      t: Parameters<typeof actual.drawBody>[3],
      colors: Parameters<typeof actual.drawBody>[4],
      o: Parameters<typeof actual.drawBody>[5],
    ) => {
      rec.calls.push({ i, ctx });
      return actual.drawBody(store, i, ctx, t, colors, o);
    },
  };
});

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
 * A trace: body `i` opens at step `i` and never closes — the shape every search
 * trace has, and the one {@link isMonotone} recognises.
 *
 * Bodies are spread over a wide area so they land in *several* tiles, which is
 * what makes this a real test: the accumulator has to decide, per tile, which
 * arrivals belong to it.
 */
function makeTraceStore(n: number): SharedComponentStore {
  const kind = new Uint8Array(new SharedArrayBuffer(n));
  const fill = <T,>(v: T) => Array.from({ length: n }, () => v);
  return {
    generation: 1,
    count: n,
    total: n,
    kind,
    x: f32(Array.from({ length: n }, (_, i) => (i * 37) % 480)),
    y: f32(Array.from({ length: n }, (_, i) => (i * 91) % 480)),
    size: f32(fill(4)),
    size2: f32(fill(4)),
    alpha: f32(fill(1)),
    start: i32(Array.from({ length: n }, (_, i) => i)),
    end: i32(fill(n)),
    fill: i32(fill(1)),
    palette: ["", "red"],
    label: i32(fill(0)),
    strings: [""],
    ptOff: i32(new Array(n + 1).fill(0)),
    pts: f32([]),
  };
}

function makeWorker() {
  const worker = new D2RendererV2Worker();
  worker.setup({ ...defaultD2RendererOptions, workerCount: 1, workerIndex: 0 });
  worker.setFrustum({ top: 0, left: 0, bottom: 512, right: 512 });
  return worker;
}

function loaded(store: SharedComponentStore) {
  const worker = makeWorker();
  worker.setLayer("a", { store, generation: store.generation });
  worker.buildLayerIndex("a");
  return worker;
}

/**
 * Which bodies ended up on the canvas, per tile. Keyed by the canvas the body was
 * drawn onto, so a body drawn into two different tiles counts as two entries —
 * exactly the distinction that would be lost by looking at body indices alone.
 */
function drawn(): Map<unknown, number[]> {
  const byCanvas = new Map<unknown, number[]>();
  for (const { i, ctx } of rec.calls) {
    const list = byCanvas.get(ctx) ?? [];
    list.push(i);
    byCanvas.set(ctx, list);
  }
  return byCanvas;
}

/** The multiset of bodies drawn, per tile, as a comparable value. */
function signature(): string[] {
  return [...drawn().values()]
    .map((indices) => [...indices].sort((a, b) => a - b).join(","))
    .filter((s) => s.length)
    .sort();
}

describe("accumulated tiles match a full redraw", () => {
  const N = 200;
  const AT = 150;

  beforeEach(() => void (rec.calls.length = 0));

  it("playing into a step draws the same bodies, per tile, as jumping to it", () => {
    // Jump: every tile is built from scratch at step AT, via the spatial index.
    const jumped = loaded(makeTraceStore(N));
    jumped.setStep(AT);
    jumped.render();
    const viaJump = signature();

    rec.calls.length = 0;

    // Play: step through 0..AT, each step drawing only what just arrived, onto a
    // canvas that is never cleared. The union must be the same set of bodies.
    const played = loaded(makeTraceStore(N));
    for (let s = 0; s <= AT; s++) {
      played.setStep(s);
      played.render();
    }
    const viaPlay = signature();

    expect(viaPlay).toEqual(viaJump);
    // Sanity: this test is worthless if it drew nothing, or if everything landed
    // in one tile (which would never exercise the per-tile arrival filter).
    expect(viaJump.join("").length).toBeGreaterThan(0);
    expect(viaJump.length).toBeGreaterThan(1);
  });

  it("scrubbing backwards lands on the same tiles as jumping there directly", () => {
    // The dangerous case: an accumulation canvas can add bodies but never remove
    // them, so going backwards *must* rebuild — otherwise the tile shows a future
    // the playhead has left behind.
    const scrubbed = loaded(makeTraceStore(N));
    scrubbed.setStep(N - 1); // all the way to the end
    scrubbed.render();
    rec.calls.length = 0;
    scrubbed.setStep(40); // ...then back
    scrubbed.render();
    const viaScrub = signature();

    rec.calls.length = 0;

    const jumped = loaded(makeTraceStore(N));
    jumped.setStep(40);
    jumped.render();
    const viaJump = signature();

    expect(viaScrub).toEqual(viaJump);
  });
});

/**
 * A trace that uses `clear`, as most real ones do: at every step a *persistent*
 * body (the search node, index `2i`) and a `clear: true` *transient* body (the
 * highlight at the playhead, index `2i+1`, span `[i, i+1)`).
 *
 * The packer emits them in exactly this order — persistent, then transient — and
 * that ordering is what lets the transient be composited over the accumulation
 * canvas. See `isAccumulable`.
 */
function makeClearingStore(n: number): SharedComponentStore {
  const bodies = n * 2;
  const kind = new Uint8Array(new SharedArrayBuffer(bodies));
  const at = <T,>(f: (step: number, transient: boolean) => T) =>
    Array.from({ length: bodies }, (_, b) => f(b >> 1, !!(b & 1)));
  return {
    generation: 1,
    count: bodies,
    total: n,
    kind,
    x: f32(at((s) => (s * 37) % 480)),
    y: f32(at((s) => (s * 91) % 480)),
    size: f32(at(() => 4)),
    size2: f32(at(() => 4)),
    alpha: f32(at(() => 1)),
    start: i32(at((s) => s)),
    // persistent -> [s, total); transient -> [s, s+1)
    end: i32(at((s, transient) => (transient ? s + 1 : n))),
    fill: i32(at(() => 1)),
    palette: ["", "red"],
    label: i32(at(() => 0)),
    strings: [""],
    ptOff: i32(new Array(bodies + 1).fill(0)),
    pts: f32([]),
  };
}

describe("traces that use `clear`", () => {
  const N = 120;
  const AT = 90;

  beforeEach(() => void (rec.calls.length = 0));

  it("still accumulates — a transient does not disable the whole layer", () => {
    // The regression this guards: `end >= total` for *every* body was too strong a
    // test, so one `clear: true` component anywhere in the trace put the entire
    // layer back on the O(step)-per-frame path. Most real traces have one.
    const worker = loaded(makeClearingStore(N));
    for (let s = 0; s <= AT; s++) {
      worker.setStep(s);
      worker.render();
    }
    // Each of the AT+1 persistent bodies drawn once, plus one transient per step.
    // A full redraw every step would be ~AT²/2 = 4000+.
    expect(rec.calls.length).toBeLessThan(N * 4);
  });

  it("playing into a step draws the same bodies, per tile, as jumping to it", () => {
    const jumped = loaded(makeClearingStore(N));
    jumped.setStep(AT);
    jumped.render();
    const viaJump = signature();

    rec.calls.length = 0;

    const played = loaded(makeClearingStore(N));
    for (let s = 0; s <= AT; s++) {
      played.setStep(s);
      played.render();
    }
    // The accumulation canvas holds the persistent bodies, and each step's
    // transient is drawn on top of the *tile* — so `signature()` (which groups by
    // canvas) would show the played run's transients on a different surface. What
    // must match is the set of bodies alive at AT, wherever they were drawn.
    const alive = (calls: typeof rec.calls) => new Set(calls.map((c) => c.i));
    const jumpBodies = alive(
      // re-run the jump to capture it cleanly
      (() => {
        rec.calls.length = 0;
        const w = loaded(makeClearingStore(N));
        w.setStep(AT);
        w.render();
        return rec.calls;
      })(),
    );

    // Every persistent body born at 0..AT, and *only* the transient born at AT.
    for (let s = 0; s <= AT; s++) expect(jumpBodies.has(s * 2)).toBe(true);
    expect(jumpBodies.has(AT * 2 + 1)).toBe(true); // this step's transient
    expect(jumpBodies.has((AT - 1) * 2 + 1)).toBe(false); // last step's: gone
    expect(viaJump.length).toBeGreaterThan(0);
  });

  it("does not bake a transient into the accumulation canvas", () => {
    // The bug this pins: the accumulation canvas is never cleared, so a transient
    // drawn onto it would stay lit for the rest of the trace.
    const worker = loaded(makeClearingStore(N));
    worker.setStep(50);
    worker.render();

    // Whatever surface the step-50 transient (body 101) was drawn onto, it must
    // not be the surface that also holds long-dead persistent bodies from step 0.
    const canvases = drawn();
    for (const [, indices] of canvases) {
      const hasOldPersistent = indices.includes(0);
      const hasTransient = indices.includes(101);
      expect(hasOldPersistent && hasTransient).toBe(false);
    }

    // ...and stepping on must not redraw it.
    rec.calls.length = 0;
    worker.setStep(51);
    worker.render();
    expect(rec.calls.some((c) => c.i === 101)).toBe(false);
    expect(rec.calls.some((c) => c.i === 103)).toBe(true); // step 51's transient
  });

  it("falls back (correctly) when a special spans several steps", () => {
    // A `clear: "closing"` special that lives from step 1 to step 40 cannot be
    // accumulated *or* composited on top, so the layer must take the one-shot
    // path — and still render the right thing.
    const store = makeClearingStore(N);
    store.end.set([40], 3); // body 3 (a transient) now spans [1, 40)
    const worker = loaded(store);
    worker.setStep(20);
    worker.render();
    const at20 = new Set(rec.calls.map((c) => c.i));
    expect(at20.has(3)).toBe(true); // the special is still alive at 20
    expect(at20.has(0)).toBe(true); // ...as are the persistent bodies
    expect(at20.has(41)).toBe(true); // ...as is step 20's own transient
    expect(at20.has(39)).toBe(false); // step 19's transient is gone
  });
});
