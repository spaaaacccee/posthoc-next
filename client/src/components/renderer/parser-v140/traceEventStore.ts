import { TraceEvent } from "protocol";
import { buildSharedEventStore, SharedEventStoreHandles } from "./sharedEventStore";

/**
 * Per-trace cache of {@link SharedEventStoreHandles}.
 *
 * A trace's events are serialised into `SharedArrayBuffer`s ONCE per trace (keyed
 * by the trace `key`, which changes whenever the content changes) and shared by
 * every worker that needs them — the streaming component generators, the tree
 * builders, the breakpoint evaluators. This replaces each of those paths
 * structured-cloning the whole 700k-event trace to its worker on the main thread
 * (a multi-second freeze), with a single shared copy the workers read directly.
 *
 * The build runs on the calling thread but yields to the event loop, so it never
 * blocks; the cached promise is reused so concurrent callers share one build.
 */
const cache = new Map<string, Promise<SharedEventStoreHandles>>();

/**
 * Get (building once, then caching) the shared event store for a trace. Callers
 * pass the same `key` + `events`; the first call builds, the rest await the same
 * promise. If a build fails it is evicted so a later call can retry.
 */
export function getSharedEventStore(
  key: string,
  events: readonly TraceEvent[],
  options: { signal?: AbortSignal } = {},
): Promise<SharedEventStoreHandles> {
  const existing = cache.get(key);
  if (existing) return existing;
  // Note: the build honours `signal`, but the cached promise is shared, so an
  // abort from one caller would reject it for all. We therefore build WITHOUT
  // the per-caller signal and let callers race their own abort against the
  // result; a stale build is cheap to discard via `disposeSharedEventStore`.
  const built = buildSharedEventStore(events).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, built);
  return options.signal ? raceAbort(built, options.signal) : built;
}

/** Resolve `p` unless `signal` aborts first (without evicting the shared build). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Prepare a worker call so the worker reads events from the shared store instead
 * of receiving a structured-clone of them. On the shared path returns the trace
 * with `events` stripped plus the `store` handles (cheap to post — the memory is
 * shared); otherwise returns the trace unchanged so the worker clones as before.
 *
 * The worker side reconstructs `trace.events` from `store` (see e.g.
 * `treeUtility.worker.ts`). Falls back transparently when SAB is unavailable, the
 * trace is keyless, or the build fails.
 */
export async function withSharedEvents<T extends { events?: readonly TraceEvent[] }>(
  key: string | undefined,
  trace: T | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<{ trace?: T; store?: SharedEventStoreHandles }> {
  const store = await getSharedEventStoreIfPossible(key, trace?.events, options);
  return store && trace ? { trace: { ...trace, events: undefined }, store } : { trace };
}

/**
 * Get the shared store for `events` if sharing is possible (SAB available,
 * cross-origin isolated, a keyed non-empty trace), else `undefined`. Never
 * throws — a failed build falls back to `undefined` so callers clone as before.
 * Use this directly when events live somewhere other than a top-level `events`
 * field (e.g. `UploadedTrace.content.events`); otherwise prefer
 * {@link withSharedEvents}.
 */
export async function getSharedEventStoreIfPossible(
  key: string | undefined,
  events: readonly TraceEvent[] | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<SharedEventStoreHandles | undefined> {
  const canShare =
    !!key &&
    !!events?.length &&
    typeof SharedArrayBuffer !== "undefined" &&
    !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (!canShare) return undefined;
  try {
    return await getSharedEventStore(key, events, options);
  } catch {
    return undefined;
  }
}

/** Peek at an already-built store without triggering a build. */
export function peekSharedEventStore(key?: string): Promise<SharedEventStoreHandles> | undefined {
  return key ? cache.get(key) : undefined;
}

/** Evict a trace's shared store (e.g. the trace changed or its layer was removed). */
export function disposeSharedEventStore(key?: string): void {
  if (key) cache.delete(key);
}
