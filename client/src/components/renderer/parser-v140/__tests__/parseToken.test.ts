import { describe, expect, it } from "vitest";
import { normalizeConstant } from "../normalize";
import { parseToken } from "../parseToken";

/**
 * `parseToken` carries the whole pre-1.4.0 compatibility story — the `ctx`/`$`
 * alias, the `__internal__` preamble, and the legacy scope fallback. All of it was
 * pinned only indirectly, through `legacy-compat`'s snapshot of 74 traces; this
 * file tests the rules themselves, so a break points at the rule that broke rather
 * than at 13k lines of diff.
 *
 * Scopes are built with `normalizeConstant`, which is how the real callers
 * (`ParseTraceSlaveWorker`, `use2DPath`) hand a scope to the parser.
 */
const scope = (o: Record<string, unknown>) => normalizeConstant(o);

describe("parseToken", () => {
  it("evaluates an expression against the scope", () => {
    expect(parseToken("1 + ctx.a + ctx.b")(scope({ a: 2, b: 3 }))).toEqual(6);
  });

  it("aliases `ctx` and `$` to the same root", () => {
    // v1.4.0 says `$.x`; the 1.0.4 dialect says `ctx.x`. Both must land on the event.
    const s = scope({ x: 7 });
    expect(parseToken("$.x")(s)).toEqual(7);
    expect(parseToken("ctx.x")(s)).toEqual(7);
    expect(parseToken("$.x === ctx.x")(s)).toBe(true);
  });

  it("invokes deferred properties on lookup", () => {
    // Scope values are thunks; reading one through the proxy must call it.
    expect(parseToken("$.a + 1")(scope({ a: () => 41 }))).toEqual(42);
  });

  it("unpacks the __internal__ preamble into bare locals", () => {
    const s = scope({
      __internal__: {
        context: { theme: "dark", color: { generating: "#00f" } },
        step: 3,
        events: [{ id: 1 }, { id: 2 }],
        parent: { id: 9 },
      },
    });
    expect(parseToken("theme")(s)).toEqual("dark");
    expect(parseToken("color.generating")(s)).toEqual("#00f");
    expect(parseToken("step")(s)).toEqual(3);
    expect(parseToken("events.length")(s)).toEqual(2);
    expect(parseToken("parent.id")(s)).toEqual(9);
  });

  it("resolves legacy scope names off __internal__", () => {
    // Legacy traces say `$.event.x`; v1.4.0 puts the event fields on the scope
    // itself. `$.event` has to keep resolving, so the whole event is served back.
    const event = { x: 4, type: "generating" };
    const s = scope({ ...event, __internal__: { event, step: 2 } });
    expect(parseToken("$.event.x")(s)).toEqual(4);
    expect(parseToken("$.x")(s)).toEqual(4);
    expect(parseToken("$.step")(s)).toEqual(2);
  });

  it("lets a real event field shadow the legacy fallback", () => {
    // The fallback is additive: it only fires when the name is undefined on the
    // scope. An event that genuinely carries `step` must win.
    const s = scope({ step: "mine", __internal__: { step: 99 } });
    expect(parseToken("$.step")(s)).toEqual("mine");
  });

  it("reaches render-context keys that the legacy scope flattened", () => {
    // `theme`, `color` and the `theme*` shorthands were spread onto the legacy
    // scope straight from the render context, so `$.themeTextPrimary` must resolve.
    const s = scope({
      __internal__: { context: { themeTextPrimary: "#fff", color: { source: "#0f0" } } },
    });
    expect(parseToken("$.themeTextPrimary")(s)).toEqual("#fff");
    expect(parseToken("$.color.source")(s)).toEqual("#0f0");
  });

  it("returns undefined for a name that resolves nowhere", () => {
    expect(parseToken("$.nothing")(scope({ a: 1 }))).toBeUndefined();
    // ...and with no `__internal__` at all, the fallback must not explode.
    expect(parseToken("$.event")(scope({ a: 1 }))).toBeUndefined();
  });
});
