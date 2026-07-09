import { TraceEvent } from "protocol";

/**
 * A single shared copy of a trace's event list, laid out in `SharedArrayBuffer`s
 * so that a fleet of generation workers can all read the SAME bytes instead of
 * each receiving a structured-clone of the whole `events` array.
 *
 * Why bytes and not a shared object graph: SAB shares raw memory, and JS object
 * graphs cannot cross a worker boundary without being cloned. So events are
 * serialised once to a concatenated JSON blob; a worker reconstructs an event
 * *on demand* (see {@link makeLazyEvents}) and lets it be GC'd after use, so the
 * per-worker live set is bounded by the working window — not by the trace length.
 *
 * Because trace templates evaluate arbitrary JS with `events`/`parent` in scope
 * (see `parseToken.ts`), events are inherently heterogeneous and cannot be
 * columnarised; a per-event JSON blob is the layout that preserves full,
 * arbitrary field access.
 *
 * Layout:
 *  - `blob`    : Uint8Array over a SAB — every event as UTF-8 JSON, concatenated.
 *  - `offsets` : Int32Array over a SAB (length `total + 1`) — event `i` occupies
 *                bytes `[offsets[i], offsets[i + 1])`.
 *  - `parents` : Int32Array over a SAB (length `total`) — precomputed parent step
 *                for event `i`, or `-1` when the event has no parent. This folds
 *                the `byId` + `findLast(step <= i)` resolution done per-frame in
 *                `ParseTraceSlaveWorker` into one O(n) pass, so workers never
 *                build an all-events index.
 */
export type SharedEventStoreHandles = {
  blob: SharedArrayBuffer;
  offsets: SharedArrayBuffer;
  parents: SharedArrayBuffer;
  total: number;
};

/** Int32 offsets cap the serialised blob at 2 GiB. */
const MAX_BLOB_BYTES = 0x7fff_ffff;

/** No parent (nullish `pId`). */
const NO_PARENT = -1;

const isNullish = (x: unknown): x is null | undefined => x === undefined || x === null;

/**
 * Serialise `events` into shared buffers. Runs in whatever thread calls it, so
 * it yields to the event loop every `yieldEvery` events to avoid a long block on
 * a large trace; pass a `signal` to abort a stale build.
 *
 * The parent step is resolved in the same pass: `parents[i]` is the largest step
 * `<= i` whose event id equals `events[i].pId` (matching the `groupBy`/`findLast`
 * fold downstream, including its string-key coercion and its `?? 0` fallback to
 * `events[0]` when the parent id is present but unseen), or `-1` when `pId` is
 * nullish.
 */
export async function buildSharedEventStore(
  events: readonly TraceEvent[],
  { yieldEvery = 1 << 14, signal }: { yieldEvery?: number; signal?: AbortSignal } = {},
): Promise<SharedEventStoreHandles> {
  const total = events.length;
  const encoder = new TextEncoder();
  // Pre-sized: one encoded chunk per event, filled in order below.
  // eslint-disable-next-line unicorn/no-new-array
  const chunks: Uint8Array[] = new Array(total);
  const offsets = new Int32Array(total + 1);
  const parents = new Int32Array(total);
  // Last step seen so far per (stringified) event id — mirrors `groupBy(_, "id")`
  // key coercion so id `0` and `"0"` collapse exactly as the original does.
  const lastStepById = new Map<string, number>();

  let size = 0;
  for (let i = 0; i < total; i++) {
    const e = events[i]!;
    const bytes = encoder.encode(JSON.stringify(e));
    chunks[i] = bytes;
    offsets[i] = size;
    size += bytes.length;
    if (size > MAX_BLOB_BYTES) {
      throw new Error(`Trace too large to share: serialised events exceed ${MAX_BLOB_BYTES} bytes`);
    }
    lastStepById.set(String(e.id), i);
    parents[i] = isNullish(e.pId) ? NO_PARENT : (lastStepById.get(String(e.pId)) ?? 0);
    if ((i & (yieldEvery - 1)) === 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await Promise.resolve();
    }
  }
  offsets[total] = size;

  const blob = new Uint8Array(new SharedArrayBuffer(size));
  for (let i = 0; i < total; i++) {
    blob.set(chunks[i]!, offsets[i]);
    // Drop the transient chunk so peak build memory stays ~1x (blob) + tail.
    chunks[i] = undefined as unknown as Uint8Array;
    if ((i & (yieldEvery - 1)) === 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await Promise.resolve();
    }
  }

  const offsetsSab = new SharedArrayBuffer(offsets.byteLength);
  new Int32Array(offsetsSab).set(offsets);
  const parentsSab = new SharedArrayBuffer(parents.byteLength);
  new Int32Array(parentsSab).set(parents);

  return {
    blob: blob.buffer as SharedArrayBuffer,
    offsets: offsetsSab,
    parents: parentsSab,
    total,
  };
}

const decoder = new TextDecoder();

/**
 * Read side of {@link SharedEventStoreHandles}. Deserialises a single event from
 * the shared blob on demand, with a small insertion-order cache so repeated
 * touches within a batch (e.g. an event and its parent) don't re-parse.
 */
export class SharedEventStore {
  readonly total: number;
  readonly parents: Int32Array;
  private readonly blob: Uint8Array;
  private readonly offsets: Int32Array;
  private readonly cache = new Map<number, TraceEvent>();
  private readonly cacheMax: number;

  constructor(handles: SharedEventStoreHandles, cacheMax = 4096) {
    this.total = handles.total;
    this.blob = new Uint8Array(handles.blob);
    this.offsets = new Int32Array(handles.offsets);
    this.parents = new Int32Array(handles.parents);
    this.cacheMax = cacheMax;
  }

  private parse(i: number): TraceEvent {
    const start = this.offsets[i]!;
    const end = this.offsets[i + 1]!;
    // Copy the slice into a non-shared buffer: TextDecoder rejects SAB-backed
    // views on some engines, and the copy is one small event.
    const buf = new Uint8Array(end - start);
    buf.set(this.blob.subarray(start, end));
    return JSON.parse(decoder.decode(buf)) as TraceEvent;
  }

  get(i: number): TraceEvent | undefined {
    if (i < 0 || i >= this.total) return undefined;
    const cached = this.cache.get(i);
    if (cached !== undefined) return cached;
    const event = this.parse(i);
    this.cache.set(i, event);
    if (this.cache.size > this.cacheMax) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return event;
  }
}

/**
 * An array-like view over a {@link SharedEventStore} that lazily materialises
 * events. Numeric indexing, `length`, iteration, and the `Array.prototype`
 * methods all work: the built-in methods only touch `length` and indexed reads,
 * which the proxy services from the store, so `events.map/filter/find/...` behave
 * correctly (materialising each event transiently rather than all at once).
 */
/**
 * Eagerly reconstruct the FULL events array (a real array) from a shared store.
 *
 * Prefer this over {@link makeLazyEvents} for consumers that scan every event
 * (tree builders, breakpoint processors): they materialise all events anyway, so
 * laziness buys nothing, and a real array avoids the lazy proxy's edge cases
 * (e.g. `Object.entries`, which needs own-key enumeration). The lazy proxy is for
 * genuinely partial access (the streaming frame generator).
 */
export function readAllEvents(store: SharedEventStore): TraceEvent[] {
  // eslint-disable-next-line unicorn/no-new-array
  const out = new Array<TraceEvent>(store.total);
  for (let i = 0; i < store.total; i++) out[i] = store.get(i)!;
  return out;
}

export function makeLazyEvents(store: SharedEventStore): TraceEvent[] {
  const handler: ProxyHandler<TraceEvent[]> = {
    get(_target, prop, receiver) {
      if (prop === "length") return store.total;
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < store.total; i++) yield store.get(i);
        };
      }
      if (typeof prop === "string") {
        const n = +prop;
        if (Number.isInteger(n) && n >= 0) return store.get(n);
        const method = (Array.prototype as unknown as Record<string, unknown>)[prop];
        if (typeof method === "function")
          return (method as (...a: unknown[]) => unknown).bind(receiver);
      }
      return undefined;
    },
    has(_target, prop) {
      if (prop === "length" || prop === Symbol.iterator) return true;
      if (typeof prop === "string") {
        const n = +prop;
        if (Number.isInteger(n) && n >= 0) return n < store.total;
        return prop in Array.prototype;
      }
      return false;
    },
  };
  return new Proxy([] as TraceEvent[], handler);
}
