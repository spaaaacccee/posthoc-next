import { mapValues } from "es-toolkit/compat";
import { Trace as LegacyTrace } from "protocol";
import { Trace, TraceComponent } from "protocol/Trace-v140";

/**
 * LEGACY COMPAT — pre-1.4.0 trace upgrade.
 *
 * Converts any older trace into the v1.4.0 shape at ingress, so the rest of the
 * app only ever sees one format and there is exactly one parser. Everything in
 * this file exists solely to support traces the app no longer natively speaks;
 * if support for them is ever dropped, this file goes with it.
 *
 * The five deltas between the formats:
 *
 * 1. Structure — `render.views[name].components` and the `render.components`
 *    template map collapse into a single flat `views` map. v1.4.0 passes
 *    `trace.views` as *both* the entry point and the template namespace.
 * 2. Pivot — `path.pivot` / `path.scale` move to a top-level `pivot`.
 * 3. Persistence — `display: "transient"` becomes `clear: true`.
 * 4. Delimiters — `{{ expr }}` becomes `${{ expr }}`.
 * 5. Scope — legacy expressions read `$.event.x` / `$.color`, v1.4.0 reads
 *    `$.x` / `color`. This one is NOT handled here: the expressions are
 *    arbitrary JS (they run through `Function`), so rewriting them means
 *    parsing JS. It is handled instead by the alias fallback in `parseToken`,
 *    which resolves the legacy scope names at evaluation time.
 *
 * Deliberately dropped, having never been read by any parser or renderer:
 * `render.context`, `views[].renderer`, `views[].onionSkin`.
 */

/**
 * `use2DPath` used to scale legacy pivots by this factor while reading them.
 * Now that the read is uniform, the factor is baked in at conversion time.
 */
export const LEGACY_PATH_SCALE = 1 / 0.3;

/** `{{` not already preceded by `$`. Makes the delimiter swap idempotent. */
const LEGACY_INTERPOLATION = /(?<!\$)\{\{/g;

/** A string that is one whole interpolation and nothing else. */
const SOLE_INTERPOLATION = /^\s*\{\{([\s\S]*)\}\}\s*$/;

export type TraceUpgrade = {
  trace: Trace;
  /**
   * The version upgraded from, or `undefined` when the trace was already
   * v1.4.0 and passed through untouched.
   */
  from?: string;
  /** Constructs that could not be faithfully converted. */
  warnings: string[];
};

type AnyTrace = LegacyTrace | Trace;

/** Legacy components carried `display` where v1.4.0 carries `clear`. */
type LegacyComponent = TraceComponent & { display?: string };

type LegacyPath = { pivot?: Record<string, unknown>; scale?: number };

/**
 * The union of every top-level key we have ever seen on a trace. Real 1.0.x
 * files carry `path` at the top level even though `protocol/Trace` declares it
 * under `render`, and 1.1.0 files carry a v1.4.0-style `pivot` alongside a
 * legacy `render`.
 */
type UpgradeableTrace = Omit<LegacyTrace, "version"> &
  Partial<Omit<Trace, "version">> & {
    version?: string;
    path?: LegacyPath;
    render?: LegacyTrace["render"] & { path?: LegacyPath };
  };

/**
 * Rewrites `{{ expr }}` to `${{ expr }}` in every string, recursing through
 * arrays and plain objects. Only ever applied to view and pivot definitions —
 * never to `events`, whose strings are user data, not expressions.
 */
function upgradeInterpolation<T>(value: T): T {
  if (typeof value === "string") return value.replace(LEGACY_INTERPOLATION, "${{") as T;
  if (Array.isArray(value)) return value.map(upgradeInterpolation) as T;
  if (value?.constructor === Object) return mapValues(value as object, upgradeInterpolation) as T;
  return value;
}

/**
 * `display` selected persistence by string; `clear` selects it by truthiness
 * (falsy → persistent, `true` → transient, string → the named "special" stack,
 * which legacy has no equivalent of).
 */
function upgradeDisplay(display: string | undefined, warnings: string[]) {
  if (display === undefined || display === "persistent") return undefined;
  if (display === "transient") return true;
  // `display` could be an expression evaluating to "transient". When it is one
  // whole interpolation it compiles to a bare value, so comparing it inline
  // yields the boolean `clear` wants.
  const [, expression] = display.match(SOLE_INTERPOLATION) ?? [];
  if (expression) return `\${{ (${upgradeInterpolation(expression)}) === "transient" }}`;
  warnings.push(
    `Could not convert 'display: ${display}' — a template with literal text around its interpolations. Treating the component as persistent.`,
  );
  return undefined;
}

function upgradeComponent(component: LegacyComponent, warnings: string[]): TraceComponent {
  const { display, ...rest } = component;
  const upgraded = upgradeInterpolation(rest) as TraceComponent;
  const clear = upgradeDisplay(display, warnings);
  return clear === undefined ? upgraded : { ...upgraded, clear };
}

const upgradeComponents = (components: LegacyComponent[], warnings: string[]) =>
  components.map((c) => upgradeComponent(c, warnings));

/**
 * Upgrades a trace of any version to v1.4.0. Idempotent, and cheap: `events`
 * is passed through by reference, so only the (small) view definitions are
 * walked. A v1.4.0 trace is returned as-is with `from` unset.
 */
export function upgradeTrace(trace: AnyTrace | undefined): TraceUpgrade {
  const warnings: string[] = [];
  if (!trace || trace.version === "1.4.0") return { trace: trace as Trace, warnings };

  const { version, render, path, pivot, views, events, ...rest } = trace as UpgradeableTrace;

  // `render.components` are templates, `render.views` are entry points; v1.4.0
  // keeps both in one namespace. On a name collision the view wins, matching
  // the legacy lookup order (a view was never resolvable as a template).
  const templates = mapValues(render?.components ?? {}, (c) =>
    upgradeComponents(c as LegacyComponent[], warnings),
  );
  const entries = mapValues(render?.views ?? {}, (v) =>
    upgradeComponents((v?.components ?? []) as LegacyComponent[], warnings),
  );
  for (const name of Object.keys(entries)) {
    if (name in templates) {
      warnings.push(`A view and a component are both named '${name}'. The view takes precedence.`);
    }
  }

  // Real 1.0.x traces put `path` at the top level even though the type declares
  // it under `render`. Accept both. A trace that already has `pivot` (1.1.0)
  // keeps it.
  const legacyPath = path ?? render?.path;
  const nextPivot =
    pivot ??
    (legacyPath
      ? {
          ...upgradeInterpolation(legacyPath.pivot ?? {}),
          // Falsy legacy scales previously fell through to a default of 1.
          scale: legacyPath.scale ? legacyPath.scale * LEGACY_PATH_SCALE : 1,
        }
      : undefined);

  return {
    from: version ?? "unversioned",
    warnings,
    trace: {
      ...rest,
      version: "1.4.0",
      views: {
        ...templates,
        ...entries,
        ...(views ? mapValues(views, (c) => upgradeComponents(c ?? [], warnings)) : {}),
      },
      ...(nextPivot ? { pivot: nextPivot } : {}),
      events,
    },
  };
}
