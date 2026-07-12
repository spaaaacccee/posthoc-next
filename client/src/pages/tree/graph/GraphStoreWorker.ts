import { queryOptions, useQuery } from "@tanstack/react-query";
import { withSharedEvents } from "components/renderer/parser-v140/traceEventStore";
import { endpointSymbol } from "vite-plugin-comlink/symbol";
import { withWorker } from "workers/workerLanes";
import type { Trace } from "protocol/Trace-v140";
import type { LayerShading } from "renderer";
import type { GraphStoreResult } from "./buildGraphStore";
import type { GraphStoreWorkerParameters, ShadeWorkerParameters } from "./graphStore.worker";

type WorkerModule = typeof import("./graphStore.worker");

// vite-plugin-comlink rewrites `new ComlinkWorker(...)` into a statement ending
// in `;`, so it MUST sit on its own line (not inside an arrow/expression).
function spawnWorker() {
  const worker = new ComlinkWorker<WorkerModule>(
    new URL("./graphStore.worker.ts", import.meta.url),
  );
  return worker;
}

const terminate = (w: ReturnType<typeof spawnWorker>) => w[endpointSymbol].terminate();

export type GraphStoreOptions = Omit<GraphStoreWorkerParameters, "store"> & { key?: string };

export const graphStoreQuery = ({ key, trace, ...options }: GraphStoreOptions) =>
  queryOptions({
    // `step` is deliberately absent, as it is from the layout query: the store is
    // built once and the playhead is a *render* input, not a build input. That is
    // the point of the ramp columns — scrubbing changes no bytes here.
    //
    // The rest of the options are all in the key, because each of them does change
    // the bytes: an axis change moves every body (and so invalidates the spatial
    // index), a mode change changes what a body even is, and a theme change
    // rewrites the palette.
    queryKey: [
      "compute/tree/graph-store",
      key,
      options.mode,
      options.orientation,
      options.x,
      options.y,
      options.log,
      options.fadeWindow,
      options.background,
      options.edgeColor,
      options.ghostColor,
      options.labelColor,
      options.colors,
      options.layout?.length,
    ],
    queryFn: async ({ signal }): Promise<GraphStoreResult> => {
      const shared = await withSharedEvents(key, trace, { signal });
      return withWorker("tree", spawnWorker, terminate, (w) => w.build({ ...options, ...shared }), {
        signal,
      });
    },
    enabled: !!key,
    staleTime: Infinity,
  });

export function useGraphStore(options: GraphStoreOptions) {
  return useQuery(graphStoreQuery(options));
}

export type GraphShadingOptions = Omit<ShadeWorkerParameters, "eventStore" | "events"> & {
  key?: string;
  trace?: Trace;
};

/**
 * A graph's colour, recomputed when the highlight or the tracked property changes
 * — and *only* then. Geometry and the spatial index are untouched, so this never
 * repacks a column or rebuilds the R-tree: see `Renderer.setLayerShading`.
 */
export const graphShadingQuery = ({ key, trace, ...options }: GraphShadingOptions) =>
  queryOptions({
    queryKey: [
      "compute/tree/graph-shading",
      key,
      options.generation,
      options.nodeOffset,
      options.trackedProperty,
      options.highlight,
      options.highlightColor,
      options.background,
      options.edgeColor,
      options.colors,
      options.fadeWindow,
      options.geometry.count,
    ],
    queryFn: async ({ signal }): Promise<LayerShading> => {
      const shared = await withSharedEvents(key, trace, { signal });
      return withWorker(
        "tree",
        spawnWorker,
        terminate,
        (w) => w.shade({ ...options, eventStore: shared.store }),
        { signal },
      );
    },
    enabled: !!key && options.geometry.count > 0,
    staleTime: Infinity,
  });

export function useGraphShading(options: GraphShadingOptions) {
  return useQuery(graphShadingQuery(options));
}
