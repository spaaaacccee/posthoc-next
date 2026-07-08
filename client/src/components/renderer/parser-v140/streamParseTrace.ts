import { endpointSymbol, proxy } from "vite-plugin-comlink/symbol";
import { leaseWorkers } from "workers/workerLanes";
import { ParseTraceWorkerParameters } from "./ParseTraceSlaveWorker";
import type { StreamBatchFrame } from "./streamParseTrace.worker";

type WorkerModule = typeof import("./streamParseTrace.worker");

export type { StreamBatchFrame };

export type TraceStream = {
  /** Push the current playhead so workers prioritise that neighbourhood. */
  setStep: (step: number) => void;
};

export type TraceStreamOptions = {
  workerCount: number;
  /** Frames to eagerly generate ahead of a jumped-to step (keep small). */
  margin?: number;
  initialStep?: number;
  onBatch: (frames: StreamBatchFrame[]) => void;
  /** Called once every worker has finished generating all of its frames. */
  onComplete?: () => void;
  onError?: (error: unknown) => void;
  /**
   * Stall watchdog: if the fleet goes fully silent for this many ms *after it has
   * started producing*, treat it as a hung/dead worker and fail via `onError`.
   *
   * This is deliberately an IDLE timeout, not a total-duration one: the timer is
   * armed only once the first batch arrives and is reset by every subsequent
   * batch, so an arbitrarily long — but live — generation never trips it. Only
   * genuine silence mid-stream does. Set to 0 to disable.
   */
  stallTimeoutMs?: number;
  /** Aborting tears down the lease: cancels the wait, terminates + frees workers. */
  signal: AbortSignal;
};

const DEFAULT_MARGIN = 64;
const DEFAULT_STALL_TIMEOUT = 30_000;

const { max, min } = Math;

// vite-plugin-comlink rewrites `new ComlinkWorker(...)` into a statement ending
// in `;`, so it MUST sit on its own line (not inside an arrow/expression) or it
// produces invalid syntax. Hence this standalone factory rather than an inline
// `Array.from(() => new ComlinkWorker(...))`.
function spawnWorker() {
  const worker = new ComlinkWorker<WorkerModule>(
    new URL("./streamParseTrace.worker.ts", import.meta.url),
  );
  return worker;
}

const terminateWorker = (w: ReturnType<typeof spawnWorker>) => w[endpointSymbol].terminate();

/**
 * Streams a trace's render components in via a fleet of long-lived Comlink
 * workers (strided so worker `owner` owns event indices ≡ `owner` mod N).
 *
 * Workers are leased from the shared `trace-gen` lane rather than spawned
 * outright, so total live workers across all traces stays bounded: a single
 * trace greedily takes the whole lane (full performance), while many traces
 * serialise through it (each waits for ≥1 permit). The lease is released — every
 * worker terminated, every permit freed — when generation completes, errors, or
 * `signal` aborts, keeping live workers == held permits.
 *
 * NOTE (deferred optimisation): each leased worker still receives its own
 * structured-clone of the full trace (~workers× the trace). Acceptable for now;
 * the fix is to share source bytes via a SharedArrayBuffer. See memory note
 * `trace-event-streaming-design`.
 */
export function createTraceStream(
  params: ParseTraceWorkerParameters,
  {
    workerCount,
    margin = DEFAULT_MARGIN,
    initialStep = 0,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT,
    onBatch,
    onComplete,
    onError,
    signal,
  }: TraceStreamOptions,
): TraceStream {
  const total = params.trace?.events?.length ?? 0;
  // No point holding more workers than there are events.
  const maxWorkers = max(1, min(workerCount, total || 1));

  let workers: ReturnType<typeof spawnWorker>[] = [];
  let latestStep = initialStep;

  // Idle-stall watchdog. Armed on the first batch, reset by every batch, so a
  // long-but-live generation never trips it — only a fleet that has gone silent
  // mid-stream. Never armed if disabled or if generation ends first.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let onStall: ((reason: unknown) => void) | undefined;
  const stalled = new Promise<never>((_, reject) => {
    onStall = reject;
  });
  stalled.catch(() => {}); // inert handler; the real consumer is the race below
  const clearStall = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const kickStall = () => {
    if (!stallTimeoutMs || signal.aborted) return;
    clearStall();
    stallTimer = setTimeout(
      () => onStall?.(new Error(`Trace generation stalled: no output for ${stallTimeoutMs}ms`)),
      stallTimeoutMs,
    );
  };
  const onBatchWatched = (frames: StreamBatchFrame[]) => {
    kickStall(); // reset the idle timer on any sign of life
    onBatch(frames);
  };

  (async () => {
    const lease = await leaseWorkers("trace-gen", spawnWorker, terminateWorker, {
      workerCount,
      min: 1,
      max: maxWorkers,
      signal,
    });
    if (!lease || signal.aborted) return;
    workers = lease.workers;
    const n = workers.length;
    const generation = Promise.all(
      workers.map((w, owner) =>
        w.generate(params, owner, n, margin, proxy(onBatchWatched), latestStep),
      ),
    );
    // Race generation against a crash (worker `error`/`messageerror`, which
    // Comlink can't surface) and the idle-stall watchdog — either resolves the
    // hang that would otherwise leak the whole `trace-gen` lease.
    Promise.race([generation, lease.crashed, stalled])
      .then(() => {
        if (!signal.aborted) onComplete?.();
      })
      .catch((e) => {
        if (!signal.aborted) onError?.(e);
      })
      .finally(() => {
        clearStall();
        lease.release();
      });
  })();

  return {
    setStep: (step) => {
      latestStep = step;
      for (const w of workers) w.setStep(step);
    },
  };
}
