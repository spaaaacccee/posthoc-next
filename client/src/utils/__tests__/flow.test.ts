import { describe, expect, it, vi } from "vitest";
import { flow, flowAsync } from "../flow";

describe("flow", () => {
  it("threads the value left to right", () => {
    expect(
      flow(
        2,
        (n) => n + 1,
        (n) => n * 10,
        String,
      ),
    ).toBe("30");
  });
});

describe("flowAsync", () => {
  it("hands each step the AWAITED result of the previous one", async () => {
    const seen: unknown[] = [];

    const out = await flowAsync(
      1,
      async (n) => n + 1,
      (n) => {
        seen.push(n);
        return Promise.resolve(`${n}`);
      },
      (s) => {
        seen.push(s);
        return s.length;
      },
    );

    expect(seen).toEqual([2, "2"]);
    expect(seen.every((s) => !(s instanceof Promise))).toBe(true);
    expect(out).toBe(1);
  });

  it("mixes sync and async steps and runs them in order", async () => {
    const order: string[] = [];

    const out = await flowAsync(
      "",
      (s) => {
        order.push("a");
        return s + "a";
      },
      async (s) => {
        await Promise.resolve();
        order.push("b");
        return s + "b";
      },
      (s) => {
        order.push("c");
        return s + "c";
      },
    );

    expect(order).toEqual(["a", "b", "c"]);
    expect(out).toBe("abc");
  });

  it("short-circuits the chain when a step rejects", async () => {
    const boom = new Error("boom");
    const later = vi.fn((n: number) => n);

    await expect(
      flowAsync(
        1,
        async () => {
          throw boom;
        },
        later,
      ),
    ).rejects.toBe(boom);

    expect(later).not.toHaveBeenCalled();
  });

  it("short-circuits on a synchronous throw too", async () => {
    const later = vi.fn((n: number) => n);

    await expect(
      flowAsync(
        1,
        (): number => {
          throw new Error("sync boom");
        },
        later,
      ),
    ).rejects.toThrow("sync boom");

    expect(later).not.toHaveBeenCalled();
  });

  it("always returns a promise, even when every step is synchronous", async () => {
    const out = flowAsync(1, (n) => n + 1);

    expect(out).toBeInstanceOf(Promise);
    await expect(out).resolves.toBe(2);
  });

  it("does not await the seed value; only step results", async () => {
    // The first step's parameter is typed `T`, not `Awaited<T>` — a promise seed
    // arrives at step 1 unawaited.
    const seed = Promise.resolve(1);
    let seen: unknown;

    await flowAsync(seed, (t) => {
      seen = t;
      return t;
    });

    expect(seen).toBe(seed);
  });
});
