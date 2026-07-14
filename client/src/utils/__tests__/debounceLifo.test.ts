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

  it("withholds a call from the debounce while an earlier invocation is still pending", async () => {
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
    g(2);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual([1, 2]);

    // 1 has still not resolved, so 3 is never handed to the debounce at all:
    // its window can elapse many times over without f running.
    g(3);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual([1, 2]);

    inFlight.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual([1, 2, 3]);
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
