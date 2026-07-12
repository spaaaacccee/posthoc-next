import {
  readAllEvents,
  SharedEventStore,
  type SharedEventStoreHandles,
} from "components/renderer/parser-v140/sharedEventStore";
import type { LayerShading } from "renderer";
import {
  buildGraphStore,
  type BuildGraphStoreOptions,
  type GraphStoreResult,
} from "./buildGraphStore";
import { shadeGraphStore, type ShadeGraphStoreOptions } from "./shadeGraphStore";

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

export type ShadeWorkerParameters = Omit<ShadeGraphStoreOptions, "events"> & {
  /** Shared *event* store handles — distinct from `geometry`, the component store. */
  eventStore?: SharedEventStoreHandles;
};

/**
 * Recolour a graph off the main thread.
 *
 * Colouring by a property has to read every event, which is exactly the O(n) scan
 * the main thread must not do on a click. The returned columns are SAB-backed, so
 * handing them back to the renderer shares them.
 */
export function shade({ eventStore, ...rest }: ShadeWorkerParameters): LayerShading {
  const events = eventStore ? readAllEvents(new SharedEventStore(eventStore)) : [];
  return shadeGraphStore({ ...rest, events });
}
