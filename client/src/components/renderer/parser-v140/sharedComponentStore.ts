import type { SharedComponentStore } from "renderer";
import type { SingleFrame } from "./ParseTraceSlaveWorker";

// Kept in lockstep with `renderer/SharedComponentStore.ts` COMPONENT_KINDS.
// Duplicated (not imported) so this app-side module type-only-imports `renderer`
// — value-importing it breaks under vitest's node resolution (the package's
// `main` points at a non-existent `index.js`; the app build maps it to source).
const COMPONENT_KINDS = ["rect", "circle", "path", "polygon", "text"] as const;

/**
 * App-side producer for the renderer's {@link SharedComponentStore}. Turns the
 * per-step, classified components of a trace into columnar SharedArrayBuffers
 * plus a contiguous `[start, end)` visibility span per body, so the renderer can
 * hold one immutable, shared index and drive visibility by playhead alone.
 *
 * The span computation is the correctness crux: it must reproduce today's
 * visibility model exactly.
 *  - persistent (no `clear`): `[birth, total)`.
 *  - own-transient (`clear` truthy, non-string): `[step, step + 1)`.
 *  - special (`clear` is a string): `[emit, clear)`, where the clear step is the
 *    first later step whose event has `id === emitterId && type === clearString`
 *    (never → `total`). This is the same stateful clear-stack fold as
 *    `advanceMerge`, run once here to stamp end-steps instead of per scrub.
 */

const KIND_INDEX: Record<string, number> = Object.fromEntries(
  COMPONENT_KINDS.map((k, i) => [k, i]),
);

/**
 * Rasterizable kinds packed by default. Note `text` is not a component `$` — no
 * trace emits `$: "text"`. It's a *label attached to* another component, and
 * appears here as a pseudo-kind toggling whether labels are packed as their own
 * bodies (see `pushBody`), mirroring v1's `draw()`, which rasterizes the
 * primitive and then overdraws its label.
 */
export const DEFAULT_INCLUDE: ReadonlySet<string> = new Set([
  "rect",
  "circle",
  "path",
  "polygon",
  "text",
]);

const GREY = "#808080";

/** Static bodies (e.g. maps) are visible at every step; open-ended span end. */
export const STATIC_END = 0x7fffffff;

/** Mirrors `traceStreamStore`'s stack key so special semantics stay identical. */
const makeKey = (id: unknown, condition: unknown) => `${id}::::${condition}`;

export type BuildComponentStoreParams = {
  /** Per-step generator: classified components + the step's event. */
  gen: (i: number) => SingleFrame;
  /** Total step count of the trace. */
  total: number;
  /** Build over `[0, prefixEnd)` (streaming preview); defaults to `total`. */
  prefixEnd?: number;
  /** Generation id stamped on the produced store. */
  generation?: number;
  /** Component kinds to pack; others are skipped (not drawn). */
  include?: ReadonlySet<string>;
};

function sab<T extends Uint8Array | Int32Array | Float32Array>(
  Ctor: new (buffer: SharedArrayBuffer) => T,
  bytesPerElement: number,
  length: number,
): T {
  return new Ctor(new SharedArrayBuffer(length * bytesPerElement));
}

function allocStore(
  count: number,
  total: number,
  generation: number,
  palette: string[],
  strings: string[],
  ptsLen: number,
): SharedComponentStore {
  return {
    generation,
    count,
    total,
    kind: sab(Uint8Array, 1, count),
    x: sab(Float32Array, 4, count),
    y: sab(Float32Array, 4, count),
    size: sab(Float32Array, 4, count),
    size2: sab(Float32Array, 4, count),
    alpha: sab(Float32Array, 4, count),
    start: sab(Int32Array, 4, count),
    end: sab(Int32Array, 4, count),
    fill: sab(Int32Array, 4, count),
    palette,
    label: sab(Int32Array, 4, count),
    strings,
    ptOff: sab(Int32Array, 4, count + 1),
    pts: sab(Float32Array, 4, ptsLen),
  };
}

/**
 * Shared columnar packer. Accumulates bodies into plain number arrays (exact
 * count known only after the pass), interns colours and label strings, and packs
 * ragged path/polygon points. `setEnd` lets the caller back-patch a special's
 * span end once its clear event is seen.
 *
 * One component may pack as *two* bodies — its primitive and, if it carries a
 * label, a text body sharing the same span — so `pushBody` returns every index
 * it wrote.
 */
function createPacker(include: ReadonlySet<string>) {
  const kind: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const size: number[] = [];
  const size2: number[] = [];
  const alpha: number[] = [];
  const start: number[] = [];
  const spanEnd: number[] = [];
  const fill: number[] = [];
  const label: number[] = [];
  const pts: number[] = [];
  const ptOff: number[] = [0];

  const palette: string[] = [""];
  const paletteIndex = new Map<string, number>([["", 0]]);
  const strings: string[] = [""];
  const stringIndex = new Map<string, number>([["", 0]]);
  const intern = (pool: string[], index: Map<string, number>, v: string) => {
    let idx = index.get(v);
    if (idx === undefined) {
      idx = pool.length;
      pool.push(v);
      index.set(v, idx);
    }
    return idx;
  };

  const pushPrimitive = (c: Record<string, any>, s: number, e: number): number => {
    const bi = kind.length;
    kind.push(KIND_INDEX[c.$] ?? 0);
    let np = 0;

    if (c.$ === "circle") {
      x.push(c.x ?? 0);
      y.push(c.y ?? 0);
      size.push(c.radius ?? 0);
      size2.push(0);
    } else if (c.$ === "path" || c.$ === "polygon") {
      // No anchor; geometry lives entirely in `points`. `size` carries the
      // path's line width (normalising the pre-1.4.0 `line-width` alias).
      x.push(0);
      y.push(0);
      size.push(c.$ === "path" ? (c.lineWidth ?? c["line-width"] ?? 0) : 0);
      size2.push(0);
      const points = Array.isArray(c.points) ? c.points : [];
      for (const p of points) pts.push(p?.x ?? 0, p?.y ?? 0);
      np = points.length;
    } else {
      // rect
      x.push(c.x ?? 0);
      y.push(c.y ?? 0);
      size.push(c.width ?? 0);
      size2.push(c.height ?? 0);
    }

    alpha.push(c.alpha ?? 1);
    fill.push(intern(palette, paletteIndex, c.fill ?? GREY));
    label.push(0);
    start.push(s);
    spanEnd.push(e);
    ptOff.push(ptOff[ptOff.length - 1]! + np);
    return bi;
  };

  /**
   * A component's label, packed as its own body. Anchored at the primitive's
   * `(x, y)` plus the label offset, matching `primitives.text.draw`; `size` is
   * the font size and `size2` an estimated pixel width used only for the bbox.
   * v1 draws labels opaque, in `label-color`, ignoring the component's fill and
   * alpha.
   */
  const pushText = (c: Record<string, any>, s: number, e: number, str: string): number => {
    const bi = kind.length;
    kind.push(KIND_INDEX.text!);
    const fontSize = c["label-size"] ?? c.fontSize ?? 4;
    x.push((c.x ?? 0) + (c["label-x"] ?? c.textX ?? 0));
    y.push((c.y ?? 0) + (c["label-y"] ?? c.textY ?? 0));
    size.push(fontSize);
    size2.push(str.length * fontSize * 0.6);
    alpha.push(1);
    fill.push(intern(palette, paletteIndex, c["label-color"] ?? c.fontColor ?? "grey"));
    label.push(intern(strings, stringIndex, str));
    start.push(s);
    spanEnd.push(e);
    ptOff.push(ptOff[ptOff.length - 1]!);
    return bi;
  };

  /**
   * Pack `c` as up to two bodies sharing one span: its primitive, and its label
   * if it has one. Returns the indices written — none, if `include` excludes
   * both. The caller needs all of them to back-patch a special's span end.
   */
  const pushBody = (c: Record<string, any>, s: number, e: number): number[] => {
    const out: number[] = [];
    if (include.has(c.$)) out.push(pushPrimitive(c, s, e));
    /// version < 1.4.0 compat: `text` is the old spelling of `label`.
    const str = c.label ?? c.text;
    if (include.has("text") && str !== undefined && str !== null && str !== "") {
      out.push(pushText(c, s, e, String(str)));
    }
    return out;
  };

  const setEnd = (bi: number, e: number) => {
    spanEnd[bi] = e;
  };

  const build = (total: number, generation: number): SharedComponentStore => {
    const count = kind.length;
    const store = allocStore(count, total, generation, palette, strings, pts.length);
    store.kind.set(kind);
    store.x.set(x);
    store.y.set(y);
    store.size.set(size);
    store.size2.set(size2);
    store.alpha.set(alpha);
    store.start.set(start);
    store.end.set(spanEnd);
    store.fill.set(fill);
    store.label.set(label);
    store.ptOff.set(ptOff);
    store.pts.set(pts);
    return store;
  };

  return { pushBody, setEnd, build };
}

/**
 * Build a store over `[0, prefixEnd)`. Single forward pass: at each step, clear
 * any specials whose clear-event just arrived, then emit the step's bodies.
 */
export function buildSharedComponentStore({
  gen,
  total,
  prefixEnd = total,
  generation = 0,
  include = DEFAULT_INCLUDE,
}: BuildComponentStoreParams): SharedComponentStore {
  const end = Math.min(prefixEnd, total);
  const { pushBody, setEnd, build } = createPacker(include);

  // clearKey -> body indices of specials awaiting that clear event.
  const stack = new Map<string, number[]>();

  for (let i = 0; i < end; i++) {
    const frame = gen(i);
    const e = frame.event;

    // 1. Clear specials waiting on this event's (id, type) — before emitting.
    const clearKey = makeKey(e?.id, e?.type);
    const pending = stack.get(clearKey);
    if (pending) {
      for (const bi of pending) setEnd(bi, i);
      stack.delete(clearKey);
    }

    // 2. Emit this step's bodies.
    const cs = frame.components;
    for (const entry of cs.persistent ?? []) pushBody(entry.component, i, total);
    for (const entry of cs.transient ?? []) pushBody(entry.component, i, i + 1);
    for (const entry of cs.special ?? []) {
      const c = entry.component;
      // end defaults to `total` until cleared; a labelled component packs two
      // bodies, and both must be cleared together.
      const bodies = pushBody(c, i, total);
      if (!bodies.length) continue;
      const key = makeKey(e?.id, c.clear);
      const arr = stack.get(key);
      if (arr) arr.push(...bodies);
      else stack.set(key, bodies);
    }
  }

  return build(total, generation);
}

/**
 * Build a store from a flat, static component list (e.g. a parsed map). Every
 * body is visible at all steps (`[0, STATIC_END)`), so the shared global step
 * driven by a trace layer never hides map geometry.
 */
export function buildStaticComponentStore(
  components: { component?: Record<string, any> }[],
  {
    generation = 0,
    include = DEFAULT_INCLUDE,
  }: { generation?: number; include?: ReadonlySet<string> } = {},
): SharedComponentStore {
  const { pushBody, build } = createPacker(include);
  for (const entry of components) {
    if (entry?.component) pushBody(entry.component, 0, STATIC_END);
  }
  return build(1, generation);
}
