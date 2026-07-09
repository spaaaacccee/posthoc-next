import { queryOptions, useQuery } from "@tanstack/react-query";
import { EventContext } from "protocol";
import { Trace } from "protocol/Trace-v140";
import type { SharedComponentStore } from "renderer";
import { endpointSymbol } from "vite-plugin-comlink/symbol";
import { withWorker } from "workers/workerLanes";
import type { BuildComponentStoreWorkerParameters } from "./buildComponentStore.worker";
import { getSharedEventStore } from "./traceEventStore";

type WorkerModule = typeof import("./buildComponentStore.worker");

// vite-plugin-comlink rewrites `new ComlinkWorker(...)` into a statement ending
// in `;`, so it MUST sit on its own line.
function spawnWorker() {
  const worker = new ComlinkWorker<WorkerModule>(
    new URL("./buildComponentStore.worker.ts", import.meta.url),
  );
  return worker;
}

const terminate = (w: ReturnType<typeof spawnWorker>) => w[endpointSymbol].terminate();

export type BuildComponentStoreOptions = {
  trace?: Trace;
  context: EventContext;
  view?: string;
  /** Stable trace identity; keys the shared event store so it's built once. */
  traceKey?: string;
  /** Build over `[0, prefixEnd)` (streaming preview); omit for the full trace. */
  prefixEnd?: number;
  generation?: number;
  /** Component kinds to pack; omit for the default (rect + circle) slice. */
  include?: string[];
  signal?: AbortSignal;
};

/**
 * Build a {@link SharedComponentStore} off the main thread. Reuses the shared
 * event store (so no events are cloned) when cross-origin isolated; otherwise
 * falls back to handing the builder worker the full trace.
 */
export async function buildComponentStore({
  trace,
  context,
  view = "main",
  traceKey,
  prefixEnd,
  generation = 0,
  include,
  signal,
}: BuildComponentStoreOptions): Promise<SharedComponentStore | undefined> {
  const events = trace?.events ?? [];
  if (!events.length) return undefined;

  const canShare =
    !!traceKey &&
    typeof SharedArrayBuffer !== "undefined" &&
    !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;

  let params: BuildComponentStoreWorkerParameters = {
    trace,
    context,
    view,
    prefixEnd,
    generation,
    include,
  };
  if (canShare) {
    try {
      const store = await getSharedEventStore(traceKey, events, { signal });
      if (signal?.aborted) return undefined;
      params = {
        trace: { ...trace, events: undefined } as Trace,
        context,
        view,
        store,
        prefixEnd,
        generation,
        include,
      };
    } catch (e) {
      console.warn("v2 store: falling back to a non-shared build", e);
    }
  }

  return withWorker("component-store", spawnWorker, terminate, (w) => w.build(params), { signal });
}

export type ComponentStoreQueryOptions = {
  /** Stable trace identity; also the cache key. */
  key?: string;
  trace?: Trace;
  context: EventContext;
  view?: string;
  /** Identity of `context`, so a theme change rebuilds the store. */
  contextKey?: string;
  include?: string[];
};

/**
 * The built store, cached per trace. Building it is expensive (a full off-main
 * frame-gen + pack), and the renderer feed unmounts whenever you navigate away
 * from the viewport — without this it would rebuild on every return.
 */
export const componentStoreQuery = ({
  key,
  trace,
  context,
  view = "main",
  contextKey,
  include,
}: ComponentStoreQueryOptions) =>
  queryOptions({
    queryKey: ["component-store", key, view, contextKey],
    queryFn: ({ signal }) =>
      buildComponentStore({ trace, context, view, traceKey: key, include, signal }),
    enabled: !!key && !!trace?.events?.length,
    staleTime: Infinity,
  });

export function useComponentStore(options: ComponentStoreQueryOptions) {
  return useQuery(componentStoreQuery(options));
}
