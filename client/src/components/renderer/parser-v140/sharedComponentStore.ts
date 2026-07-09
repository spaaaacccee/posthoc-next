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

/** First-slice coverage: the pure-scalar primitives. Broadened in P6. */
export const DEFAULT_INCLUDE: ReadonlySet<string> = new Set(["rect", "circle"]);

const GREY = "#808080";

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
    // No ragged points in the first slice; zero-initialised (all offsets 0).
    ptOff: sab(Int32Array, 4, count + 1),
    pts: sab(Float32Array, 4, 0),
  };
}

/**
 * Build a store over `[0, prefixEnd)`. Single forward pass: at each step, clear
 * any specials whose clear-event just arrived, then emit the step's bodies with
 * their spans. Bodies accumulate in plain number arrays and are copied into the
 * SAB columns at the end (exact size known only after the pass).
 */
export function buildSharedComponentStore({
  gen,
  total,
  prefixEnd = total,
  generation = 0,
  include = DEFAULT_INCLUDE,
}: BuildComponentStoreParams): SharedComponentStore {
  const end = Math.min(prefixEnd, total);

  const kind: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const size: number[] = [];
  const size2: number[] = [];
  const alpha: number[] = [];
  const start: number[] = [];
  const spanEnd: number[] = [];
  const fill: number[] = [];

  const palette: string[] = [""]; // index 0 = "none"
  const paletteIndex = new Map<string, number>([["", 0]]);
  const internColor = (c?: string) => {
    const key = c ?? "";
    let idx = paletteIndex.get(key);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(key);
      paletteIndex.set(key, idx);
    }
    return idx;
  };

  // clearKey -> body indices of specials awaiting that clear event.
  const stack = new Map<string, number[]>();

  const pushBody = (c: Record<string, any>, s: number, e: number): number => {
    const bi = kind.length;
    kind.push(KIND_INDEX[c.$] ?? 0);
    if (c.$ === "circle") {
      x.push(c.x ?? 0);
      y.push(c.y ?? 0);
      size.push(c.radius ?? 0);
      size2.push(0);
    } else {
      // rect (and, later, others that carry x/y/width/height)
      x.push(c.x ?? 0);
      y.push(c.y ?? 0);
      size.push(c.width ?? 0);
      size2.push(c.height ?? 0);
    }
    alpha.push(c.alpha ?? 1);
    fill.push(internColor(c.fill ?? GREY));
    start.push(s);
    spanEnd.push(e);
    return bi;
  };

  for (let i = 0; i < end; i++) {
    const frame = gen(i);
    const e = frame.event;

    // 1. Clear specials waiting on this event's (id, type) — before emitting.
    const clearKey = makeKey(e?.id, e?.type);
    const pending = stack.get(clearKey);
    if (pending) {
      for (const bi of pending) spanEnd[bi] = i;
      stack.delete(clearKey);
    }

    // 2. Emit this step's bodies.
    const cs = frame.components;
    for (const entry of cs.persistent ?? []) {
      if (include.has(entry.component.$)) pushBody(entry.component, i, total);
    }
    for (const entry of cs.transient ?? []) {
      if (include.has(entry.component.$)) pushBody(entry.component, i, i + 1);
    }
    for (const entry of cs.special ?? []) {
      const c = entry.component;
      if (!include.has(c.$)) continue;
      const bi = pushBody(c, i, total); // end defaults to `total` until cleared
      const key = makeKey(e?.id, c.clear);
      const arr = stack.get(key);
      if (arr) arr.push(bi);
      else stack.set(key, [bi]);
    }
  }

  const count = kind.length;
  const store = allocStore(count, total, generation, palette);
  store.kind.set(kind);
  store.x.set(x);
  store.y.set(y);
  store.size.set(size);
  store.size2.set(size2);
  store.alpha.set(alpha);
  store.start.set(start);
  store.end.set(spanEnd);
  store.fill.set(fill);
  return store;
}
