import { describe, expect, it, vi } from "vitest";
import { Sema } from "workers/semaphore";

describe("Sema", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new Sema(0)).toThrow(RangeError);
    expect(() => new Sema(1.5)).toThrow(RangeError);
  });

  it("hands out up to `capacity` permits without blocking, then no more", () => {
    const sema = new Sema(2);
    expect(sema.tryAcquire()).toBeDefined();
    expect(sema.tryAcquire()).toBeDefined();
    expect(sema.tryAcquire()).toBeUndefined();
    expect(sema.free).toBe(0);
  });

  it("blocks `acquire` while full and resumes it on release", async () => {
    const sema = new Sema(1);
    const first = await sema.acquire();

    const resumed = vi.fn();
    const second = sema.acquire().then(resumed);
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();

    sema.release(first);
    await second;
    expect(resumed).toHaveBeenCalledOnce();
    expect(sema.free).toBe(0);
  });

  it("wakes waiters in FIFO order", async () => {
    const sema = new Sema(1);
    const held = await sema.acquire();
    const order: number[] = [];

    const waiters = [1, 2, 3].map((n) => sema.acquire().then((p) => (order.push(n), p)));

    sema.release(held);
    for (const w of waiters) sema.release(await w);

    expect(order).toEqual([1, 2, 3]);
  });

  it("hands a freed permit to a waiter rather than to a later tryAcquire", async () => {
    const sema = new Sema(1);
    const held = await sema.acquire();
    const waiting = sema.acquire();

    sema.release(held);

    expect(sema.tryAcquire()).toBeUndefined();
    await expect(waiting).resolves.toBeDefined();
  });

  it("ignores a double release, so capacity cannot inflate", async () => {
    const sema = new Sema(1);
    const permit = await sema.acquire();

    sema.release(permit);
    sema.release(permit);

    expect(sema.free).toBe(1);
    expect(sema.tryAcquire()).toBeDefined();
    expect(sema.tryAcquire()).toBeUndefined();
  });
});
