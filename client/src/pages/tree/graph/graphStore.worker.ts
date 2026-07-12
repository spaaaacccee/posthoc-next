import {
  readAllEvents,
  SharedEventStore,
  type SharedEventStoreHandles,
} from "components/renderer/parser-v140/sharedEventStore";
import {
  buildGraphStore,
  type BuildGraphStoreOptions,
  type GraphStoreResult,
} from "./buildGraphStore";

export type GraphStoreWorkerParameters = Omit<BuildGraphStoreOptions, "trace"> & {
  trace?: BuildGraphStoreOptions["trace"];
  /** Shared event store handles; when present, `trace.events` is read from them. */
  store?: SharedEventStoreHandles;
};

/**
 * Synthesize a graph store off the main thread.
 *
 * The result's typed arrays are all `SharedArrayBuffer`-backed, so returning it
 * across Comlink shares the memory rather than copying it — the same reason the
 * events arrive here as handles rather than as a structured clone. A 717k-event
 * trace is ~40MB of columns; neither direction can afford a copy.
 */
export function build({ trace, store, ...rest }: GraphStoreWorkerParameters): GraphStoreResult {
  const events = store ? readAllEvents(new SharedEventStore(store)) : trace?.events;
  return buildGraphStore({ ...rest, trace: trace ? { ...trace, events } : undefined });
}
