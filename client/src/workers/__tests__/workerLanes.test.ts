import { afterEach, describe, expect, it, vi } from "vitest";
import { settings } from "slices/settings";
import { endpointSymbol } from "vite-plugin-comlink/symbol";
import {
  type LaneName,
  type LeaseOptions,
  leaseWorkers,
  resolveWorkerCount,
  WorkerCrashError,
  withWorker,
} from "workers/workerLanes";

// The real settings store transitively imports MUI, which vitest's resolver
// cannot load. Same store library, only the key this module reads.
vi.mock("slices/settings", async () => {
  const { store } = await import("@davstack/store");
  return {
    settings: store<{ "performance/workerCount"?: number }>({ "performance/workerCount": 1 }),
  };
});

/** An `EventTarget`-ish worker endpoint whose listeners we can count. */
class FakeEndpoint {
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();

  addEventListener(type: string, listener: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (e: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }

  emit(event: Event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

type FakeWorker = { id: number; [endpointSymbol]: FakeEndpoint };

/** A spawn/terminate pair that records what it was asked to do. */
function fleet() {
  const spawned: FakeWorker[] = [];
  const terminated: FakeWorker[] = [];
  return {
    spawned,
    terminated,
    spawn: (): FakeWorker => {
      const worker = { id: spawned.length, [endpointSymbol]: new FakeEndpoint() };
      spawned.push(worker);
      return worker;
    },
    terminate: (worker: FakeWorker) => void terminated.push(worker),
    endpoint: (i: number) => spawned[i][endpointSymbol],
  };
}

const lease = (lane: LaneName, f: ReturnType<typeof fleet>, options: LeaseOptions = {}) =>
  leaseWorkers(lane, f.spawn, f.terminate, options);

/**
 * Permits free in a lane right now, via a non-blocking greedy lease that hands
 * everything straight back — so probing never perturbs the lane.
 * `workerCount` must match the lane's current sizing or the probe rebuilds it.
 */
async function free(lane: LaneName, workerCount?: number) {
  const f = fleet();
  const probe = await lease(lane, f, { workerCount, min: 0, max: Infinity });
  const count = probe!.workers.length;
  probe!.release();
  return count;
}

const flush = () => new Promise((resolve) => void setTimeout(resolve, 0));

const setWorkerCount = (n: number | undefined) =>
  settings.set((s) => {
    s["performance/workerCount"] = n;
  });

const setHardwareConcurrency = (n: number) =>
  Object.defineProperty(navigator, "hardwareConcurrency", { value: n, configurable: true });

afterEach(() => {
  setWorkerCount(1);
  Reflect.deleteProperty(navigator, "hardwareConcurrency");
});

describe("resolveWorkerCount", () => {
  it("prefers the configured count over the hardware estimate, unclamped", () => {
    setHardwareConcurrency(4);
    setWorkerCount(6);
    expect(resolveWorkerCount()).toBe(6);

    setWorkerCount(40);
    expect(resolveWorkerCount()).toBe(40);
  });

  it("auto-sizes to a quarter of the hardware threads when unconfigured", () => {
    setHardwareConcurrency(32);
    setWorkerCount(undefined);
    expect(resolveWorkerCount()).toBe(8);

    // ≤1 is the "auto" sentinel, not a literal request for one worker.
    setWorkerCount(1);
    expect(resolveWorkerCount()).toBe(8);
    setWorkerCount(0);
    expect(resolveWorkerCount()).toBe(8);
  });

  it("applies the same rules to a value passed in as to the live setting", () => {
    // `useTraceStream` reads the setting reactively and passes the value here, so
    // the two must agree — if they can drift, the `trace-gen` lane is rebuilt on
    // every stream and its cap stops bounding anything.
    setHardwareConcurrency(32);
    setWorkerCount(undefined);

    expect(resolveWorkerCount(6)).toBe(6);
    // ≤1 is the "auto" sentinel here too, not a request for one worker.
    expect(resolveWorkerCount(1)).toBe(8);
    expect(resolveWorkerCount(undefined)).toBe(8);
    // And an explicit value overrides the setting rather than reading past it.
    setWorkerCount(3);
    expect(resolveWorkerCount(6)).toBe(6);
  });

  it("clamps the auto estimate to [1, 12]", () => {
    setWorkerCount(1);

    setHardwareConcurrency(1);
    expect(resolveWorkerCount()).toBe(1);
    setHardwareConcurrency(2);
    expect(resolveWorkerCount()).toBe(1);
    setHardwareConcurrency(8);
    expect(resolveWorkerCount()).toBe(2);
    setHardwareConcurrency(64);
    expect(resolveWorkerCount()).toBe(12);
    setHardwareConcurrency(256);
    expect(resolveWorkerCount()).toBe(12);
  });
});

describe("lane caps", () => {
  it("weights each lane independently of the others", async () => {
    const caps: [LaneName, number][] = [
      ["trace-gen", 8],
      ["tree", 4],
      ["parse", 2],
      ["map-parse", 2],
      ["hash", 1],
      ["compress", 1],
      ["breakpoint", 1],
      ["component-store", 1],
    ];
    for (const [lane, cap] of caps) expect(await free(lane, 8)).toBe(cap);
  });

  it("floors `trace-gen` at 1 and `tree` at 2, however small the budget", async () => {
    expect(await free("trace-gen", 1)).toBe(1);
    expect(await free("tree", 1)).toBe(2);
    expect(await free("tree", 2)).toBe(2);
    expect(await free("tree", 10)).toBe(5);
  });

  it("sizes a lane from the live setting when the lease gives no workerCount", async () => {
    setWorkerCount(5);
    expect(await free("trace-gen")).toBe(5);
  });
});

describe("leaseWorkers", () => {
  it("spawns exactly one worker per acquired permit and hands them all back", async () => {
    const f = fleet();
    const held = (await lease("trace-gen", f, { workerCount: 6, max: Infinity }))!;

    expect(held.workers).toHaveLength(6);
    expect(f.spawned).toHaveLength(6);
    expect(await free("trace-gen", 6)).toBe(0);

    held.release();

    expect(f.terminated).toEqual(f.spawned);
    expect(await free("trace-gen", 6)).toBe(6);
  });

  it("bounds the greedy grab by `max`, leaving the rest of the lane usable", async () => {
    const a = fleet();
    const b = fleet();
    const first = (await lease("trace-gen", a, { workerCount: 7, min: 1, max: 3 }))!;

    expect(first.workers).toHaveLength(3);
    expect(await free("trace-gen", 7)).toBe(4);

    const second = (await lease("trace-gen", b, { workerCount: 7, max: Infinity }))!;

    expect(second.workers).toHaveLength(4);
    expect(await free("trace-gen", 7)).toBe(0);

    first.release();
    second.release();
    expect(await free("trace-gen", 7)).toBe(7);
  });

  it("takes whatever is free without blocking when `min` is 0", async () => {
    const a = fleet();
    const b = fleet();
    const held = (await lease("compress", a, { max: Infinity }))!;

    const empty = (await lease("compress", b, { min: 0, max: Infinity }))!;

    expect(empty.workers).toEqual([]);
    expect(b.spawned).toEqual([]);

    held.release();
    expect(await free("compress")).toBe(1);
  });

  it("blocks for `min` permits, spawning nothing until the lane frees up", async () => {
    const a = fleet();
    const b = fleet();
    const held = (await lease("compress", a, { min: 1 }))!;

    const pending = lease("compress", b, { min: 1 });
    const resumed = vi.fn();
    void pending.then(resumed);
    await flush();

    expect(resumed).not.toHaveBeenCalled();
    // A worker must not be spawned against a permit that was never granted.
    expect(b.spawned).toEqual([]);

    held.release();
    const granted = (await pending)!;

    expect(resumed).toHaveBeenCalledOnce();
    expect(granted.workers).toHaveLength(1);
    expect(b.spawned).toHaveLength(1);

    granted.release();
    expect(await free("compress")).toBe(1);
  });

  it("clamps `min` to the lane's cap instead of waiting on a permit that cannot exist", async () => {
    // `compress` has a cap of 1. Asking for 3 used to block forever on the second:
    // the lane can never issue it, and with no signal there is nothing to break the
    // wait — a deadlock with no way out. Take the whole lane instead.
    const f = fleet();
    const granted = (await lease("compress", f, { min: 3 }))!;

    expect(granted.workers).toHaveLength(1);
    expect(f.spawned).toHaveLength(1);

    granted.release();
    expect(await free("compress")).toBe(1);
  });

  it("returns null and spawns nothing when the signal is already aborted", async () => {
    const f = fleet();
    const result = await lease("map-parse", f, { signal: AbortSignal.abort() });

    expect(result).toBeNull();
    expect(f.spawned).toEqual([]);
    expect(await free("map-parse")).toBe(2);
  });

  it("gives back the permits it already holds when a blocked lease is aborted", async () => {
    const held = fleet();
    const blocked = fleet();
    // `parse` caps at 2. Hold one of them, so a lease asking for both takes the
    // free permit and then parks in the blocking loop waiting on the second.
    // (The lane has to be this wide: `min` is clamped to the cap now, so a lease
    // can no longer park on a permit the lane could never issue at all.)
    const lane = (await lease("parse", held, { min: 1, max: 1 }))!;
    const controller = new AbortController();

    const pending = lease("parse", blocked, { min: 2, max: 2, signal: controller.signal });
    await flush();

    expect(await free("parse")).toBe(0);

    controller.abort();

    expect(await pending).toBeNull();
    expect(blocked.spawned).toEqual([]);
    await flush();

    lane.release();
    await flush();
    // The abandoned `acquire()` still resolves later; its permit must be returned
    // or the lane is wedged for the rest of the session.
    expect(await free("parse")).toBe(2);
  });

  it("terminates and releases at most once, however often release is called", async () => {
    const a = fleet();
    const b = fleet();
    const one = (await lease("trace-gen", a, { workerCount: 3, min: 1, max: 1 }))!;
    const two = (await lease("trace-gen", b, { workerCount: 3, max: Infinity }))!;

    expect(two.workers).toHaveLength(2);

    one.release();
    one.release();
    one.release();

    expect(a.terminated).toHaveLength(1);
    // 1:1 permit↔worker. A count-based release would have credited 3 here and
    // let the lane over-issue against workers that are still alive.
    expect(await free("trace-gen", 3)).toBe(1);

    two.release();
    expect(await free("trace-gen", 3)).toBe(3);
  });

  it("releases in-flight leases into their own semaphore after a resize", async () => {
    const small = fleet();
    const big = fleet();
    const old = (await lease("trace-gen", small, { workerCount: 2, max: Infinity }))!;

    expect(old.workers).toHaveLength(2);

    // Resizing rebuilds the lane; the new semaphore starts empty.
    const fresh = (await lease("trace-gen", big, { workerCount: 4, max: Infinity }))!;

    expect(fresh.workers).toHaveLength(4);

    old.release();

    // Crediting the rebuilt lane with the old lease's permits would inflate it
    // past its cap, so the release must land on the semaphore it took from.
    expect(await free("trace-gen", 4)).toBe(0);

    fresh.release();
    expect(await free("trace-gen", 4)).toBe(4);
  });
});

describe("crash detection", () => {
  it("rejects `crashed` with the message of an `error` event", async () => {
    const f = fleet();
    const held = (await lease("parse", f, { min: 1, max: 1 }))!;

    f.endpoint(0).emit(new ErrorEvent("error", { message: "wasm abort" }));

    await expect(held.crashed).rejects.toBeInstanceOf(WorkerCrashError);
    await expect(held.crashed).rejects.toThrow("wasm abort");

    held.release();
    expect(await free("parse")).toBe(2);
  });

  it("falls back to a generic message when the event carries none", async () => {
    const f = fleet();
    const held = (await lease("parse", f, { min: 1, max: 1 }))!;

    f.endpoint(0).emit(new Event("error"));

    await expect(held.crashed).rejects.toThrow("Worker terminated unexpectedly");

    held.release();
  });

  it("rejects `crashed` on `messageerror`", async () => {
    const f = fleet();
    const held = (await lease("parse", f, { min: 1, max: 1 }))!;

    f.endpoint(0).emit(new Event("messageerror"));

    await expect(held.crashed).rejects.toThrow(
      "Worker sent a message that could not be deserialized",
    );

    held.release();
  });

  it("watches every worker of the fleet, not just the first", async () => {
    const f = fleet();
    const held = (await lease("parse", f, { max: Infinity }))!;

    expect(held.workers).toHaveLength(2);
    expect(f.endpoint(0).listenerCount).toBe(2);

    f.endpoint(1).emit(new ErrorEvent("error", { message: "second died" }));

    await expect(held.crashed).rejects.toThrow("second died");

    held.release();
  });

  it("detaches the listeners on release, so a later crash cannot reject", async () => {
    const f = fleet();
    const held = (await lease("parse", f, { min: 1, max: 1 }))!;
    const rejected = vi.fn();
    held.crashed.catch(rejected);

    held.release();

    expect(f.endpoint(0).listenerCount).toBe(0);

    f.endpoint(0).emit(new ErrorEvent("error", { message: "too late" }));
    await flush();

    expect(rejected).not.toHaveBeenCalled();
  });

  it("skips workers that expose no endpoint but still watches the rest", async () => {
    const endpoint = new FakeEndpoint();
    let spawns = 0;
    const spawn = () => (spawns++ === 0 ? {} : { [endpointSymbol]: endpoint });
    const held = (await leaseWorkers("parse", spawn, () => {}, { max: Infinity }))!;

    expect(held.workers).toHaveLength(2);

    endpoint.emit(new ErrorEvent("error", { message: "the watched one died" }));

    await expect(held.crashed).rejects.toThrow("the watched one died");

    held.release();
    expect(await free("parse")).toBe(2);
  });
});

describe("withWorker", () => {
  it("returns the task's result and always releases the worker", async () => {
    const f = fleet();

    const result = await withWorker("component-store", f.spawn, f.terminate, async (w) => {
      expect(await free("component-store")).toBe(0);
      return `ran on ${w.id}`;
    });

    expect(result).toBe("ran on 0");
    expect(f.terminated).toEqual(f.spawned);
    expect(await free("component-store")).toBe(1);
  });

  it("takes exactly one permit even on a wide lane", async () => {
    const f = fleet();

    await withWorker(
      "tree",
      f.spawn,
      f.terminate,
      async () => {
        expect(f.spawned).toHaveLength(1);
        expect(await free("tree", 8)).toBe(3);
      },
      { workerCount: 8 },
    );

    expect(await free("tree", 8)).toBe(4);
  });

  it("releases the worker when the task throws", async () => {
    const f = fleet();
    const boom = new Error("task failed");

    await expect(
      withWorker("component-store", f.spawn, f.terminate, () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    expect(f.terminated).toHaveLength(1);
    expect(await free("component-store")).toBe(1);
  });

  it("frees the permit when a worker crashes mid-task instead of wedging the lane", async () => {
    const f = fleet();

    const crashing = withWorker("breakpoint", f.spawn, f.terminate, (w) => {
      w[endpointSymbol].emit(new ErrorEvent("error", { message: "OOM" }));
      // A dead worker never posts a response, so a real Comlink call would hang
      // here forever and the `finally` that frees the permit would never run.
      return new Promise<never>(() => {});
    });

    await expect(crashing).rejects.toBeInstanceOf(WorkerCrashError);
    await expect(crashing).rejects.toThrow("OOM");
    expect(f.terminated).toHaveLength(1);
    expect(await free("breakpoint")).toBe(1);

    const after = fleet();
    await expect(
      withWorker("breakpoint", after.spawn, after.terminate, async () => "lane still open"),
    ).resolves.toBe("lane still open");
  });

  it("throws AbortError and spawns nothing when aborted", async () => {
    const f = fleet();

    await expect(
      withWorker("component-store", f.spawn, f.terminate, async () => "unreachable", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(DOMException);

    expect(f.spawned).toEqual([]);
    expect(await free("component-store")).toBe(1);
  });
});
