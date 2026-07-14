import { describe, expect, it } from "vitest";
import { result, resultAsync } from "../result";

describe("result", () => {
  it("wraps a returned value as { result } and omits `error` entirely", () => {
    const r = result(() => 42);

    expect(r).toEqual({ result: 42 });
    expect("error" in r).toBe(false);
  });

  it("reports a successful `undefined` as a result, not as an absent one", () => {
    // Callers discriminate on key presence, so a void function must still
    // produce a `result` key or it is indistinguishable from a failure.
    const r = result(() => undefined);

    expect("result" in r).toBe(true);
    expect("error" in r).toBe(false);
  });

  it("wraps a throw as { error } and omits `result` entirely", () => {
    const boom = new Error("boom");
    const r = result((): number => {
      throw boom;
    });

    expect(r).toEqual({ error: boom });
    expect(r.error).toBe(boom);
    expect("result" in r).toBe(false);
  });

  it("passes a non-Error throw through unchanged", () => {
    const r = result(() => {
      throw "just a string";
    });

    expect(r.error).toBe("just a string");
  });

  it("does not catch anything thrown after it returns", () => {
    const f = () => () => {
      throw new Error("later");
    };
    const { result: inner } = result(f);

    expect(inner).toBeTypeOf("function");
    expect(() => inner!()).toThrow("later");
  });
});

describe("resultAsync", () => {
  it("wraps a resolved value as { result } and omits `error` entirely", async () => {
    const r = await resultAsync(async () => 42);

    expect(r).toEqual({ result: 42 });
    expect("error" in r).toBe(false);
  });

  it("wraps a rejection as { error } and omits `result` entirely", async () => {
    const boom = new Error("boom");
    const r = await resultAsync<number, Error>(async () => {
      throw boom;
    });

    expect(r).toEqual({ error: boom });
    expect(r.error).toBe(boom);
    expect("result" in r).toBe(false);
  });

  it("catches a synchronous throw from the callback, not just a rejection", () => {
    // The callback is invoked inside the try block, so a callback that throws
    // before returning a promise must not blow up the caller.
    const boom = new Error("sync boom");
    const r = resultAsync<number, Error>(() => {
      throw boom;
    });

    return expect(r).resolves.toEqual({ error: boom });
  });

  it("never rejects, whatever the callback does", async () => {
    await expect(
      resultAsync(async () => {
        throw "not an error object";
      }),
    ).resolves.toEqual({ error: "not an error object" });
  });

  it("unwraps a nested promise result", async () => {
    const { result: value } = await resultAsync(async () => await Promise.resolve(1));

    expect(value).toBe(1);
  });
});
