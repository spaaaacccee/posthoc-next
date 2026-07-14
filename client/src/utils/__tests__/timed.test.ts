import { describe, expect, it, vi } from "vitest";
import { timed, wait } from "../timed";

describe("wait", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const p = wait(100).then(done);
      await vi.advanceTimersByTimeAsync(99);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("timed", () => {
  it("returns the task's result when it wins", async () => {
    const { result, error, timedOut } = await timed(async () => "ok", 1000);
    expect(result).toEqual("ok");
    expect(error).toBeUndefined();
    expect(timedOut).toBeUndefined();
  });

  it("reports a timeout when the task is too slow", async () => {
    vi.useFakeTimers();
    try {
      const p = timed(() => new Promise<string>(() => {}), 1000);
      await vi.advanceTimersByTimeAsync(1000);
      const { result, timedOut, error } = await p;
      expect(result).toBeUndefined();
      expect(timedOut).toBe(true);
      expect(error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a rejection instead of swallowing it", async () => {
    const { result, error } = await timed(async () => {
      throw new Error("boom");
    }, 1000);
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toEqual("boom");
  });

  it("fails fast on rejection rather than serving out the timeout", async () => {
    // The bug this replaced: `Promise.any` ignores rejections until *every* promise
    // rejects, so a task that threw waited out the full `ms` before reporting
    // nothing. Connection probes paid 2.5s to learn a solver was down.
    const from = performance.now();
    const { error, timedOut } = await timed(async () => {
      throw new Error("boom");
    }, 5000);
    expect(performance.now() - from).toBeLessThan(1000);
    expect(error).toBeInstanceOf(Error);
    expect(timedOut).toBeUndefined();
  });

  it("distinguishes a task that resolves undefined from a timeout", async () => {
    const { result, timedOut } = await timed(async () => undefined, 1000);
    expect(result).toBeUndefined();
    expect(timedOut).toBeUndefined();
  });

  it("does not leave the timeout timer pending once the task wins", async () => {
    vi.useFakeTimers();
    try {
      await timed(async () => "ok", 5000);
      // A stale timer would keep the loop alive for the rest of `ms`.
      expect(vi.getTimerCount()).toEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures how long the task took", async () => {
    const { delta } = await timed(async () => {
      await wait(20);
      return "ok";
    }, 1000);
    expect(delta).toBeGreaterThanOrEqual(15);
  });
});
