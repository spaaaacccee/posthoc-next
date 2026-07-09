import { Context, Prop } from "./Context";
import { normalize } from "./normalize";

/**
 * LEGACY COMPAT — pre-1.4.0 scope names.
 *
 * Legacy traces evaluated against a flat scope, so they say `$.event.x` and
 * `$.color[$.event.type]`. v1.4.0 puts the event on the scope's *prototype*
 * (`$.x`) and tucks everything else under `__internal__`, which this token's
 * preamble unpacks into bare locals (`step`, `events`, …).
 *
 * `upgradeTrace` cannot rewrite those references — the expressions are
 * arbitrary JS run through `Function`, and traces really do use bare `$.event`
 * as a value (`{{'x' in $.event ? ... }}`), so a textual rewrite would mean
 * parsing JS. Instead they are resolved here, at lookup time.
 *
 * The fallback only fires when the name resolves to `undefined` on the scope
 * and the event, so a real event field named `step` still shadows it. It is
 * purely additive for v1.4.0 traces.
 *
 * Older still (1.0.4 and its `converted/` output) is a third dialect that binds
 * the root as `ctx` and reads event fields straight off it — `ctx.x`, not
 * `ctx.event.x`. That is precisely how v1.4.0's `$` behaves, so aliasing the
 * two is all it takes. These traces never worked under the legacy parser, which
 * bound only `$`; they threw `ReferenceError: ctx is not defined`.
 */
const LEGACY_EVENT_SCOPE = ["event", "events", "step", "parent"] as const;

type Internal = {
  context?: Record<string, unknown>;
  event?: unknown;
  events?: unknown;
  step?: unknown;
  parent?: unknown;
};

/** Resolves a value off the normalized scope, invoking deferred props. */
const read = (target: Context, prop: string | symbol) => {
  const value = (target as Record<string | symbol, unknown>)?.[prop];
  return typeof value === "function" ? value({}) : value;
};

/** LEGACY COMPAT — see {@link LEGACY_EVENT_SCOPE}. */
function readLegacyScope(target: Context, prop: string) {
  const internal = read(target, "__internal__") as Internal | undefined;
  if (!internal) return undefined;
  if ((LEGACY_EVENT_SCOPE as readonly string[]).includes(prop)) {
    return internal[prop as (typeof LEGACY_EVENT_SCOPE)[number]];
  }
  // `theme`, `color`, and the flattened `theme*` shorthands were spread onto
  // the legacy scope straight from the render context.
  return internal.context?.[prop];
}

export const parseToken = (token: string): Prop<any> => {
  const f = Function(
    "$",
    `
      const theme = $.__internal__?.context?.theme;
      const color = $.__internal__?.context?.color;
      const step = $.__internal__?.step;
      const events = $.__internal__?.events;
      const parent = $.__internal__?.parent;
      const ctx = $; // LEGACY COMPAT — the 1.0.4 dialect's name for the root.
      return ${token};
  `,
  );
  return (ctx) =>
    f(
      new Proxy(normalize(ctx), {
        get(target, prop) {
          const value = read(target, prop);
          // LEGACY COMPAT — fall back to the pre-1.4.0 scope names.
          if (value === undefined && typeof prop === "string" && prop !== "__internal__") {
            return readLegacyScope(target, prop);
          }
          return value;
        },
      }),
    );
};
