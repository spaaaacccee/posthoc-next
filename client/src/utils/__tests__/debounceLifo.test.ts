import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounceLifo } from "../debounceLifo";

// Lets a test hold one invocation of `f` "in flight" for as long as it likes.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Drains the microtask queue (where the LIFO hand-off between calls happens)
// without moving the fake clock.
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("debounceLifo", () => {
  it("defers the call by `wait` and defaults `wait` to 1000ms", async () => {
    const f = vi.fn(async () => {});
    const g = debounceLifo(f);

    g();
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(f).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into a single call carrying only the last args", async () => {
    const f = vi.fn(async (_: number) => {});
    const g = debounceLifo(f, 100);

    g(1);
    g(2);
    g(3);
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    expect(f.mock.calls).toEqual([[3]]);
  });

  it("never overlaps two invocations, however long the first one runs", async () => {
    const runs: number[] = [];
    const inFlight = deferred();
    const f = vi.fn(async (n: number) => {
      runs.push(n);
      await inFlight.promise;
    });
    const g = debounceLifo(f, 100);

    g(1);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual([1]);

    // f(1) has not settled, so nothing else may run — the whole point of this
    // function is that two edits cannot `produce` against the same layer at once.
    // The window can elapse many times over and f is still not called again.
    g(2);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual([1]);

    g(3);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual([1]);

    // Once it settles, the newest withheld args go — and only those.
    inFlight.resolve();
    await settle();
    expect(runs).toEqual([1, 3]);
    expect(f).not.toHaveBeenCalledWith(2);
  });

  it("settles the returned promise with the invocation the call was folded into", async () => {
    const f = vi.fn(async (n: number) => n);
    const g = debounceLifo(f, 100);

    const done = vi.fn();
    void g(1).then(done);
    void g(2).then(done);
    await settle();
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await settle();
    // Both callers were coalesced into the one invocation, and both settle with it.
    expect(done).toHaveBeenCalledTimes(2);
    expect(f.mock.calls).toEqual([[2]]);
  });

  it("rejects the returned promise when f fails, rather than leaving it unhandled", async () => {
    const boom = new Error("save failed");
    const g = debounceLifo(async () => {
      throw boom;
    }, 100);

    const caught = vi.fn();
    const p = g().catch(caught);
    await vi.advanceTimersByTimeAsync(100);
    await p;

    expect(caught).toHaveBeenCalledWith(boom);
  });

  it("keeps running after a failed invocation", async () => {
    const f = vi.fn(async (n: number) => {
      if (n === 1) throw new Error("save failed");
    });
    const g = debounceLifo(f, 100);

    await vi.advanceTimersByTimeAsync(0);
    void g(1).catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    // A rejection must clear the in-flight gate, or the lane wedges for good.
    void g(2).catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(f.mock.calls).toEqual([[1], [2]]);
  });

  it("re-invokes with only the last of the calls it withheld", async () => {
    const runs: number[] = [];
    const inFlight = deferred();
    const f = vi.fn(async (n: number) => {
      runs.push(n);
      await inFlight.promise;
    });
    const g = debounceLifo(f, 100);

    g(1);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual([1]);

    // 2, 3 and 4 all arrive while f(1) is in flight.
    for (const n of [2, 3, 4]) {
      g(n);
      await settle();
    }
    expect(runs).toEqual([1]);

    inFlight.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    expect(runs).toEqual([1, 4]);
    expect(f).not.toHaveBeenCalledWith(2);
    expect(f).not.toHaveBeenCalledWith(3);
  });

  it("keeps accepting calls after an invocation has settled", async () => {
    const f = vi.fn(async (_: string) => {});
    const g = debounceLifo(f, 100);

    for (const arg of ["a", "b", "c"]) {
      g(arg);
      await settle();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(f.mock.calls).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps each debounced function's schedule independent", async () => {
    const f = vi.fn(async (_: string) => {});
    const a = debounceLifo(f, 100);
    const b = debounceLifo(f, 100);

    a("a");
    b("b");
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    expect(f.mock.calls).toEqual([["a"], ["b"]]);
  });
});
