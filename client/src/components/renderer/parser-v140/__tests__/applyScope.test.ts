import { describe, expect, it } from "vitest";
import { applyScope } from "../applyScope";
import { normalize } from "../normalize";

/**
 * `applyScope(scope, props)` binds every own property of `props` to `scope` and
 * hangs `scope` off the result's prototype. Two consequences worth pinning:
 * the binding happens once, at apply time, so the context a prop is later
 * called with is ignored; and a property resolves against its *parent* scope,
 * never against its siblings.
 */

/**
 * Both arguments of `applyScope` have to share one `T`, so the scope and the
 * properties applied to it cannot each infer their own. `parse` — the only real
 * caller — resolves that `T` to `Record<string, any>`; do the same here.
 */
const props = (o: Record<string, unknown>) => normalize<Record<string, any>>(o);

describe("applyScope", () => {
  it("binds properties to the scope they are applied with", () => {
    const result = applyScope(props({ a: 1 }), props({ b: "${{ctx.a + 1}}" }));
    expect(result.b({})).toEqual(2);
  });

  it("ignores the context a bound property is called with", () => {
    const result = applyScope(props({ a: 1 }), props({ b: "${{ctx.a + 1}}" }));
    // The scope is captured at apply time, so passing a different one here is a
    // no-op. `parse` relies on this when it evaluates props as `prop(element)`.
    expect(result.b(props({ a: 100 }))).toEqual(2);
  });

  it("exposes scope keys on the prototype, not as own keys", () => {
    const scope = props({ a: 1 });
    const result = applyScope(scope, props({ b: "${{ctx.a + 1}}" }));
    expect(Object.keys(result)).toEqual(["b"]);
    expect(Object.getPrototypeOf(result)).toBe(scope);
    expect(result.a({})).toEqual(1);
  });

  it("passes the component name through unwrapped", () => {
    const result = applyScope(props({}), props({ $: "rect", x: 1 }));
    expect(result.$).toEqual("rect");
    expect(result.x({})).toEqual(1);
  });

  it("resolves through a chain of scopes", () => {
    const outer = props({ a: 1 });
    const inner = applyScope(outer, props({ b: "${{ctx.a + 1}}" }));
    const result = applyScope(inner, props({ c: "${{ctx.a + ctx.b}}" }));
    // `a` is reached through two prototype hops, `b` through one.
    expect(result.c({})).toEqual(3);
  });

  it("keeps already-bound properties bound when re-scoped", () => {
    const first = applyScope(props({ a: 1 }), props({ b: "${{ctx.a + 1}}" }));
    const rebound = applyScope(props({ a: 100 }), first);
    // `b` was bound to the first scope and stays there; only the prototype moves.
    expect(rebound.b({})).toEqual(2);
    expect(rebound.a({})).toEqual(100);
  });
});
