import { queryOptions, useQuery } from "@tanstack/react-query";
import { endpointSymbol } from "vite-plugin-comlink/symbol";
import { withWorker } from "workers/workerLanes";
import { withSharedEvents } from "components/renderer/parser-v140/traceEventStore";
import {
  TreeWorkerParameters as TreeLayoutWorkerParameters,
  TreeWorkerReturnType as TreeLayoutWorkerReturnType,
} from "./treeLayout.worker";

type WorkerModule = typeof import("./treeLayout.worker");

// vite-plugin-comlink rewrites `new ComlinkWorker(...)` into a statement ending
// in `;`, so it MUST sit on its own line (not inside an arrow/expression).
function spawnWorker() {
  const worker = new ComlinkWorker<WorkerModule>(
    new URL("./treeLayout.worker.ts", import.meta.url),
  );
  return worker;
}

const terminate = (w: ReturnType<typeof spawnWorker>) => w[endpointSymbol].terminate();

export type TreeLayoutOptions = TreeLayoutWorkerParameters & { key?: string };

export const treeLayoutQuery = ({ key, mode, orientation, trace }: TreeLayoutOptions) =>
  queryOptions({
    // `step` is intentionally NOT part of the key: the layout (`parse`) is
    // step-independent, so keying on it re-ran the worker — re-cloning the whole
    // trace — on every playback step for no change.
    queryKey: ["compute/tree/layout", key, mode, orientation],
    // React Query's `signal` aborts the lease (terminating the worker) if the
    // query is cancelled — e.g. the key changes before this resolves.
    queryFn: async ({ signal }): Promise<TreeLayoutWorkerReturnType> => {
      const shared = await withSharedEvents(key, trace, { signal });
      return withWorker(
        "tree",
        spawnWorker,
        terminate,
        (w) => w.parse({ mode, orientation, ...shared }),
        {
          signal,
        },
      );
    },
    enabled: !!key,
    staleTime: Infinity,
  });

export function useTreeLayout(options: TreeLayoutOptions) {
  return useQuery(treeLayoutQuery(options));
}
