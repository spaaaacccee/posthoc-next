import { clamp } from "es-toolkit/compat";
import { settings as settingsStore } from "slices/settings";
import { endpointSymbol } from "vite-plugin-comlink/symbol";
import { Permit, Sema } from "workers/semaphore";

/**
 * Generic worker concurrency limiter.
 *
 * Worker-threaded jobs are grouped into named "lanes" (task classes). Each lane
 * has its own counting semaphore with an INDEPENDENT cap, so a long-running job
 * in one lane (e.g. a streaming trace) can never starve a short job in another
 * (e.g. parsing a freshly imported file). Caps are weighted rather than an
 * equal split, so the heavy parallel lane (`trace-gen`) keeps ~the whole budget
 * while light lanes stay small. The total is soft-bounded by Σ caps — lanes are
 * meant to separate work that rarely runs simultaneously, so the sum is rarely
 * realised, but it is always finite (unlike the old ungated spawning).
 *
 * This is the substrate for the Comlink migration: every short one-shot worker
 * class is routed through it via `withWorker`, and the streaming `trace-gen`
 * fleet via `leaseWorkers`.
 */
export type LaneName =
  | "trace-gen"
  | "parse"
  | "tree"
  | "hash"
  | "compress"
  | "map-parse"
  | "breakpoint"
  | "component-store";

const { max, floor } = Math;

/**
 * Thrown when a leased worker dies out-of-band — i.e. it fires an `error` or
 * `messageerror` event rather than returning a value or a caught exception.
 *
 * This is the failure mode Comlink CANNOT surface on its own: a proxied call
 * resolves only when the worker posts a matching response, so a worker that
 * crashes (module-eval throw, WASM `abort()`, OOM kill, `self.close()`, or an
 * un-cloneable argument/return) would otherwise leave the call pending FOREVER —
 * and, because the permit is only released in a `finally`, permanently deadlock
 * the lane. Turning the crash into a rejection lets the `finally` run, freeing
 * the permit and propagating a real error to the caller / React Query.
 */
export class WorkerCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCrashError";
  }
}

/** Best-effort access to a leased worker's raw endpoint (a `Worker`). */
function endpointOf(worker: unknown): (Worker & EventTarget) | undefined {
  const ep = (worker as Record<symbol, unknown>)?.[endpointSymbol];
  return ep && typeof (ep as EventTarget).addEventListener === "function"
    ? (ep as Worker & EventTarget)
    : undefined;
}

type CrashWatch = {
  /**
   * Rejects with a {@link WorkerCrashError} the moment any watched worker emits
   * `error`/`messageerror`. Never resolves. Pre-handled so that, if it is
   * disposed before anyone races against it, it does not surface as an
   * unhandled rejection.
   */
  crashed: Promise<never>;
  /** Detach every listener. Idempotent. */
  dispose: () => void;
};

/**
 * Attach crash listeners to every leased worker that exposes an endpoint.
 * Workers without an addressable endpoint (non-Comlink leases) are simply not
 * watched — the `crashed` promise still exists but only reflects the ones we can
 * observe.
 */
function watchCrash(workers: readonly unknown[]): CrashWatch {
  const cleanups: (() => void)[] = [];
  const crashed = new Promise<never>((_, reject) => {
    for (const w of workers) {
      const ep = endpointOf(w);
      if (!ep) continue;
      const onError = (e: Event) =>
        reject(new WorkerCrashError((e as ErrorEvent).message || "Worker terminated unexpectedly"));
      const onMessageError = () =>
        reject(new WorkerCrashError("Worker sent a message that could not be deserialized"));
      ep.addEventListener("error", onError);
      ep.addEventListener("messageerror", onMessageError);
      cleanups.push(() => {
        ep.removeEventListener("error", onError);
        ep.removeEventListener("messageerror", onMessageError);
      });
    }
  });
  // Keep an inert handler so a disposed-before-consumed watch never trips the
  // global unhandledrejection path; the real consumer still sees the rejection.
  crashed.catch(() => {});
  return {
    crashed,
    dispose: () => {
      for (const c of cleanups) c();
      cleanups.length = 0;
    },
  };
}

/**
 * The preferred worker count, read live from settings. Mirrors `useTraceStream`:
 * a configured value ≤1 means "auto" — a fraction of the hardware threads,
 * clamped to a sane range. Lane callers no longer need to thread this through;
 * leases resolve it here so every lane is sized consistently.
 */
export function resolveWorkerCount(): number {
  const configured = settingsStore.get((s) => s["performance/workerCount"]);
  return configured && configured > 1
    ? configured
    : clamp(floor(navigator.hardwareConcurrency / 4), 1, 12);
}

/** Weighted, independent per-lane caps derived from the preferred worker count. */
function laneCap(name: LaneName, workerCount: number): number {
  switch (name) {
    case "trace-gen":
      return max(1, workerCount); // heavy + parallel: keep the full budget
    case "tree":
      return max(2, floor(workerCount / 2));
    case "parse":
    case "map-parse":
      return 2;
    case "hash":
    case "compress":
    case "breakpoint":
    case "component-store":
      return 1;
  }
}

const lanes = new Map<LaneName, { sema: Sema; cap: number }>();

/**
 * Get (or build) the semaphore for a lane sized for `workerCount`. If the
 * preferred count changed, the lane is rebuilt with a new cap; any outstanding
 * leases keep a reference to their original semaphore and release into it
 * harmlessly, so a live settings change is safe (it just takes effect for
 * subsequent leases).
 */
function laneSema(name: LaneName, workerCount: number = resolveWorkerCount()): Sema {
  const cap = laneCap(name, workerCount);
  const existing = lanes.get(name);
  if (existing && existing.cap === cap) return existing.sema;
  const entry = { sema: new Sema(cap), cap };
  lanes.set(name, entry);
  return entry.sema;
}

export type WorkerLease<T> = {
  /** The spawned workers (one per acquired permit). */
  workers: T[];
  /** Idempotent: terminates every worker and releases every permit, 1:1. */
  release: () => void;
  /**
   * Rejects with a {@link WorkerCrashError} if any leased worker crashes (fires
   * `error`/`messageerror`). Never resolves. Race your worker task against this
   * so a crash becomes a rejection instead of a permanent hang; `release()`
   * detaches the listeners.
   */
  crashed: Promise<never>;
};

export type LeaseOptions = {
  /** Preferred fleet size; defaults to the live `performance/workerCount` setting. */
  workerCount?: number;
  /** Permits to acquire blocking before starting (waits for availability). */
  min?: number;
  /** Upper bound on permits; `Infinity` greedily takes all currently free. */
  max?: number;
  signal?: AbortSignal;
};

/**
 * Acquire one permit, aborting the wait if `signal` fires. If the abort wins the
 * race the underlying `acquire()` is still pending, so we release its permit once
 * it eventually resolves — never leaking one.
 */
async function acquireOrAbort(sema: Sema, signal?: AbortSignal): Promise<Permit | null> {
  if (signal?.aborted) return null;
  const acquired = sema.acquire();
  if (!signal) return acquired;
  const aborted = new Promise<null>((resolve) =>
    signal.addEventListener("abort", () => resolve(null), { once: true }),
  );
  const winner = await Promise.race([acquired.then((permit) => ({ permit })), aborted]);
  if (winner === null) {
    acquired.then((permit) => sema.release(permit)).catch(() => {});
    return null;
  }
  return winner.permit;
}

/**
 * Lease workers from a lane: blocks for `min` permits, then greedily takes up to
 * `max` more without waiting. Spawns one worker per permit via `spawn`, and
 * returns an idempotent `release` (also wired to `signal`) that terminates every
 * worker and frees every permit. Resolves `null` if aborted before the workers
 * could be spawned.
 */
export async function leaseWorkers<T>(
  lane: LaneName,
  spawn: () => T,
  terminate: (worker: T) => void,
  { workerCount, min = 1, max = Infinity, signal }: LeaseOptions,
): Promise<WorkerLease<T> | null> {
  const sema = laneSema(lane, workerCount);
  const permits: Permit[] = [];
  const workers: T[] = [];
  let released = false;
  let watch: CrashWatch | undefined;

  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", release);
    watch?.dispose();
    for (const w of workers) {
      try {
        terminate(w);
      } catch (e) {
        console.warn(e);
      }
    }
    for (const p of permits) sema.release(p);
    workers.length = 0;
    permits.length = 0;
  };

  // Blocking acquire of the minimum, abortable.
  for (let i = 0; i < min; i++) {
    const permit = await acquireOrAbort(sema, signal);
    if (permit === null) {
      release();
      return null;
    }
    permits.push(permit);
  }
  // Greedily grab whatever else is free right now.
  while (permits.length < max) {
    const permit = sema.tryAcquire();
    if (permit === undefined) break;
    permits.push(permit);
  }
  if (signal?.aborted) {
    release();
    return null;
  }

  for (let i = 0; i < permits.length; i++) workers.push(spawn());
  watch = watchCrash(workers);
  signal?.addEventListener("abort", release, { once: true });
  return { workers, release, crashed: watch.crashed };
}

/**
 * Run a one-shot job on a single leased worker from `lane`. Acquires exactly one
 * permit, spawns the worker, runs `task`, and always terminates + releases.
 * Intended for short jobs as they migrate onto Comlink.
 */
export async function withWorker<T, R>(
  lane: LaneName,
  spawn: () => T,
  terminate: (worker: T) => void,
  task: (worker: T) => Promise<R>,
  options: Omit<LeaseOptions, "min" | "max"> = {},
): Promise<R> {
  const lease = await leaseWorkers(lane, spawn, terminate, { ...options, min: 1, max: 1 });
  if (!lease) throw new DOMException("Aborted", "AbortError");
  try {
    // Race the job against the crash signal: if the worker dies mid-call the
    // Comlink promise would hang forever, so `lease.crashed` is what turns that
    // into a rejection (and lets the `finally` free the permit).
    return await Promise.race([task(lease.workers[0]), lease.crashed]);
  } finally {
    lease.release();
  }
}
