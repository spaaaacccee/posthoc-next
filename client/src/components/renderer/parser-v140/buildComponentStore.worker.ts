import type { SharedComponentStore } from "renderer";
import { createFrameGenerator, ParseTraceWorkerParameters } from "./ParseTraceSlaveWorker";
import { buildSharedComponentStore } from "./sharedComponentStore";
import { makeLazyEvents, SharedEventStore, SharedEventStoreHandles } from "./sharedEventStore";

export type BuildComponentStoreWorkerParameters = ParseTraceWorkerParameters & {
  /** Shared event bytes; reconstructed here so no events are cloned to build. */
  store?: SharedEventStoreHandles;
  /** Build over `[0, prefixEnd)`. Defaults to the full trace. */
  prefixEnd?: number;
  /** Generation id stamped on the produced store. */
  generation?: number;
  /** Component kinds to pack; omit for the default (rect + circle) slice. */
  include?: string[];
};

/**
 * Dedicated, off-main builder: reconstructs a lazy event accessor from the
 * shared event store (no clone), re-runs the frame generator, and packs the
 * result into a columnar {@link SharedComponentStore}. Only the SAB handles
 * cross back to the main thread — the columns are shared, not copied.
 */
export function build(params: BuildComponentStoreWorkerParameters): SharedComponentStore {
  let genParams: ParseTraceWorkerParameters = params;
  let total = params.trace?.events?.length ?? 0;
  if (params.store) {
    const s = new SharedEventStore(params.store);
    genParams = { ...params, events: makeLazyEvents(s), parents: s.parents };
    total = s.total;
  }
  const gen = createFrameGenerator(genParams);
  return buildSharedComponentStore({
    gen,
    total,
    prefixEnd: params.prefixEnd ?? total,
    generation: params.generation ?? 0,
    include: params.include ? new Set(params.include) : undefined,
  });
}
