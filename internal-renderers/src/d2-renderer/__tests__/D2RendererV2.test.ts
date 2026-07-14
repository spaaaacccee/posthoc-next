import type { Viewport } from "pixi-viewport";
import type { SharedComponentStore } from "renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main-thread half of the shipping renderer, and the largest untested module
 * in the repo. It cannot be driven end to end here — tiles, hit-testing and the
 * upload queue all run through PIXI, which needs a GPU — so `setupPixi` is the one
 * thing stubbed out. Everything below it is the real class: a real
 * `SharedComponentStore`, a real Flatbush, the real index cache.
 *
 * The worker fleet is faked at its message boundary, which is a seam the design
 * already has rather than one invented for the test: workers only ever receive
 * `call(action, payload)` and only ever answer with `on(event)`.
 *
 * NOT covered (they need a real PIXI context, and are verified in the browser):
 * tile upload/eviction, the hover overlay, and `#click` hit-test ordering.
 */
const { workers, FakeWorker } = vi.hoisted(() => {
  const workers: FakeWorkerType[] = [];
  class FakeWorker {
    calls: { action: string; payload: unknown[] }[] = [];
    handlers = new Map<string, (e: unknown) => void>();
    onerror?: (e: unknown) => void;
    terminated = false;
    constructor() {
      workers.push(this as unknown as FakeWorkerType);
    }
    call(action: string, payload: unknown[] = []) {
      this.calls.push({ action, payload });
    }
    on(event: string, handler: (e: unknown) => void) {
      this.handlers.set(event, handler);
      return () => this.handlers.delete(event);
    }
    /** Answer as the real worker would. */
    emit(event: string, payload: unknown) {
      this.handlers.get(event)?.(payload);
    }
    terminate() {
      this.terminated = true;
    }
    sent(action: string) {
      return this.calls.filter((c) => c.action === action);
    }
  }
  type FakeWorkerType = InstanceType<typeof FakeWorker>;
  return { workers, FakeWorker };
});

vi.mock("../D2RendererV2WorkerAdapter", () => ({ D2RendererV2WorkerAdapter: FakeWorker }));

const { D2RendererV2 } = await import("../D2RendererV2");
const { buildIndex } = await import("../columnarIndex");

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

/** Two rects: (0,0,10x10) and (50,50,10x10). Bounds of the pair are (0,0)-(60,60). */
function makeStore(generation = 1): SharedComponentStore {
  const n = 2;
  const kind = new Uint8Array(new SharedArrayBuffer(n));
  kind.set([0, 0]);
  return {
    generation,
    count: n,
    total: 10,
    kind,
    x: f32([0, 50]),
    y: f32([0, 50]),
    size: f32([10, 10]),
    size2: f32([10, 10]),
    alpha: f32([1, 1]),
    start: i32([0, 0]),
    end: i32([10, 10]),
    fill: i32([1, 1]),
    palette: ["", "red"],
    label: i32([0, 0]),
    strings: [""],
    ptOff: i32(new Array(n + 1).fill(0)),
    pts: f32([]),
  };
}

const viewportStub = () =>
  ({
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    on: vi.fn(),
    resize: vi.fn(),
    animate: vi.fn(),
    findFit: vi.fn(() => 2),
  }) as unknown as Viewport;

/** The real renderer, with only the GPU boundary replaced. */
class TestRenderer extends D2RendererV2 {
  protected override async setupPixi() {
    this.viewport = viewportStub();
  }
}

const setup = async (options = {}) => {
  const r = new TestRenderer();
  await r.setup({ workerCount: 3, ...options });
  return r;
};

beforeEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
});

describe("D2RendererV2", () => {
  describe("worker fleet", () => {
    it("spins up `workerCount` workers, each told which one it is", async () => {
      await setup({ workerCount: 3 });
      expect(workers).toHaveLength(3);
      expect(workers.map((w) => w.sent("setup")[0]!.payload[0])).toMatchObject([
        { workerIndex: 0 },
        { workerIndex: 1 },
        { workerIndex: 2 },
      ]);
    });

    it("terminates its workers on destroy", async () => {
      const r = await setup();
      r.destroy();
      expect(workers.every((w) => w.terminated)).toBe(true);
    });
  });

  describe("load", () => {
    it("announces the layer to every worker, but asks only worker 0 to index it", async () => {
      const r = await setup();
      const store = makeStore();
      const handle = r.load(store, { index: 1 });

      for (const w of workers) {
        expect(w.sent("setLayer")[0]!.payload[0]).toEqual(handle);
      }
      // Packing the Flatbush is O(n log n); doing it on every worker would be that
      // cost times the fleet, for an identical buffer.
      expect(workers[0]!.sent("buildLayerIndex")).toHaveLength(1);
      expect(workers[1]!.sent("buildLayerIndex")).toHaveLength(0);
      expect(workers[2]!.sent("buildLayerIndex")).toHaveLength(0);
    });

    it("opens the index and announces the layer once worker 0 answers", async () => {
      const r = await setup();
      const store = makeStore();
      const indexed = vi.fn();
      r.on("layerIndexed", indexed);
      const handle = r.load(store);

      expect(indexed).not.toHaveBeenCalled();

      workers[0]!.emit("index", { handle, index: buildIndex(store) });

      for (const w of workers) {
        expect(w.sent("setLayerIndex")[0]!.payload[0]).toEqual(handle);
      }
      // The layer only has bounds now — a `fitCamera` before this fits nothing.
      expect(indexed).toHaveBeenCalledWith(handle);
    });

    it("reuses a cached index rather than rebuilding it", async () => {
      // The remount case: a viewport re-`load()`ing a store react-query still holds.
      // It has to be drawable synchronously, or the tiles blink.
      const r = await setup();
      const store = makeStore();
      const first = r.load(store);
      workers[0]!.emit("index", { handle: first, index: buildIndex(store) });

      const r2 = await setup();
      const indexed = vi.fn();
      r2.on("layerIndexed", indexed);
      const second = r2.load(store);

      expect(workers.at(-3)!.sent("buildLayerIndex")).toHaveLength(0);
      // Announced asynchronously, so a listener registered right after `load()` hears it.
      await Promise.resolve();
      expect(indexed).toHaveBeenCalledWith(second);
    });

    it("stops tracking a layer once unloaded", async () => {
      const r = await setup();
      const handle = r.load(makeStore());
      r.unload(handle);
      for (const w of workers) {
        expect(w.sent("removeLayer")[0]!.payload[0]).toEqual(handle);
      }
      // An index that lands after the unload must not resurrect the layer.
      expect(() =>
        workers[0]!.emit("index", { handle, index: buildIndex(makeStore()) }),
      ).not.toThrow();
    });
  });

  describe("setStep", () => {
    it("advances the playhead through shared memory, without messaging the workers", async () => {
      const r = await setup();
      const buffer = workers[0]!.sent("setStepBuffer")[0]!.payload[0] as SharedArrayBuffer;
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);

      r.setStep(7);

      // The whole point: playback costs the main thread one store to memory, not a
      // message per worker per step.
      expect(Atomics.load(new Int32Array(buffer), 0)).toEqual(7);
      expect(workers.flatMap((w) => w.sent("setStep"))).toHaveLength(0);
    });

    it("does nothing when the step has not moved", async () => {
      const r = await setup();
      const buffer = workers[0]!.sent("setStepBuffer")[0]!.payload[0] as SharedArrayBuffer;
      r.setStep(7);
      Atomics.store(new Int32Array(buffer), 0, 999); // a write only a re-store would undo
      r.setStep(7);
      expect(Atomics.load(new Int32Array(buffer), 0)).toEqual(999);
    });

    it("falls back to a message per worker without cross-origin isolation", async () => {
      // No `SharedArrayBuffer` means no shared playhead, so the step has to be posted.
      vi.stubGlobal("SharedArrayBuffer", undefined);
      const r = await setup();
      expect(workers[0]!.sent("setStepBuffer")).toHaveLength(0);

      r.setStep(4);

      for (const w of workers) {
        expect(w.sent("setStep")[0]!.payload[0]).toEqual(4);
      }
    });
  });

  describe("layer mutation", () => {
    it("merges params and broadcasts them", async () => {
      const r = await setup();
      const handle = r.load(makeStore(), { index: 1 });
      r.setLayerParams(handle, { index: 5 });
      for (const w of workers) {
        expect(w.sent("setLayerParams")[0]!.payload).toEqual([handle, { index: 5 }]);
      }
    });

    it("ignores a handle it does not hold", async () => {
      const r = await setup();
      r.setLayerParams("nonexistent", { index: 5 });
      r.setLayerShading("nonexistent", { palette: ["red"] });
      expect(workers.flatMap((w) => w.sent("setLayerParams"))).toHaveLength(0);
      expect(workers.flatMap((w) => w.sent("setLayerShading"))).toHaveLength(0);
    });

    it("broadcasts shading, keeping the geometry", async () => {
      const r = await setup();
      const handle = r.load(makeStore());
      r.setLayerShading(handle, { palette: ["", "blue"] });
      for (const w of workers) {
        expect(w.sent("setLayerShading")[0]!.payload).toEqual([handle, { palette: ["", "blue"] }]);
      }
    });
  });

  describe("fitCamera", () => {
    it("fits the union of the indexed layers' bounds", async () => {
      const r = await setup();
      const store = makeStore();
      const handle = r.load(store);
      workers[0]!.emit("index", { handle, index: buildIndex(store) });

      r.fitCamera();

      const viewport = (r as unknown as { viewport: Viewport }).viewport;
      const [call] = (viewport.animate as unknown as ReturnType<typeof vi.fn>).mock.calls;
      // Bodies span (0,0)-(60,60), so the camera centres on (30, 30).
      expect(call[0].position).toMatchObject({ x: 30, y: 30 });
      expect(call[0].scale).toBeCloseTo(2 * 0.8);
    });

    it("fits nothing when the predicate excludes every layer", async () => {
      const r = await setup();
      const store = makeStore();
      const handle = r.load(store, { sourceLayer: "a" });
      workers[0]!.emit("index", { handle, index: buildIndex(store) });

      r.fitCamera((b) => b.meta?.sourceLayer === "not-a");

      const viewport = (r as unknown as { viewport: Viewport }).viewport;
      expect(viewport.animate).not.toHaveBeenCalled();
    });

    it("fits nothing before the index has landed", async () => {
      // Bounds come from the Flatbush; without one there is nothing to fit to.
      const r = await setup();
      r.load(makeStore());
      r.fitCamera();
      const viewport = (r as unknown as { viewport: Viewport }).viewport;
      expect(viewport.animate).not.toHaveBeenCalled();
    });
  });

  it("keeps add() inert, so a stray v1 call cannot half-populate it", async () => {
    const r = await setup();
    const remove = r.add();
    expect(remove).toBeTypeOf("function");
    expect(() => remove()).not.toThrow();
    expect(workers.flatMap((w) => w.sent("setLayer"))).toHaveLength(0);
  });
});
