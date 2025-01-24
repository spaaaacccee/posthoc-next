import { TraceLayerData } from "layers/trace";
import { isTraceLayer } from "layers/trace/isTraceLayer";
import { makePathIndex, Node } from "layers/trace/makePathIndex";
import {
  chain,
  find,
  findLastIndex,
  forEach,
  forOwn,
  isUndefined,
  noop,
  set,
} from "lodash";
import { produce } from "produce";
import { useCallback } from "react";
import { Layer, useLayer } from "slices/layers";
import { AccentColor } from "theme";
export const highlightNodesOptions = [
  {
    type: "backtracking",
    color: "cyan" satisfies AccentColor,
    description:
      "Show all events from the root to the currently selected event",
  },
  {
    type: "precedent",
    color: "lime" satisfies AccentColor,
    description: "Show all precedents of the currently selected node",
  },
  {
    type: "subtree",
    color: "green" satisfies AccentColor,
    description: "Show all consequences of the currently selected node",
  },
  {
    type: "bounds-relevant",
    color: "deepPurple" satisfies AccentColor,
    description: "",
  },
] as const;

export type HighlightLayerData = {
  highlighting?: {
    step: number;
    type: string;
    path: number[] | Subtree;
  };
};

export interface Subtree {
  [key: number]: Subtree;
}

export const isHighlightLayer = (
  layer: Layer
): layer is Layer<HighlightLayerData & TraceLayerData> =>
  // For now, we'll define highlighting layers as any search trace layer.
  // It could be better to decouple this "highlight-able" idea from search traces.
  isTraceLayer(layer);

export function useHighlightNodes(key?: string): {
  [K in (typeof highlightNodesOptions)[number]["type"]]: (step: number) => void;
} {
  const { layer, setLayer } = useLayer(key, isHighlightLayer);
  const trace = layer?.source?.trace?.content;

  const showBacktracking = useCallback(
    (step: number) => {
      if (trace) {
        const { getPath } = makePathIndex(trace);
        const path: number[] = getPath(step);
        if (path.length > 1) {
          setLayer(
            produce(layer, (l) =>
              set(l?.source!, "highlighting", {
                type: "backtracking",
                step,
                path,
              })
            )!
          );
        } else {
          setLayer(produce(layer, (l) => set(l?.source!, "highlighting", {}))!);
        }
      }
    },
    [layer?.source?.highlighting, trace]
  );

  const groupedTraceById = chain(trace?.events)
    .map((c, i) => ({ step: i, id: c.id, pId: c.pId }))
    .groupBy("id")
    .value();

  const getPrecedentEvents = (
    root: Node,
    visited = new Set<number | string>()
  ) => {
    if (visited.has(root.step)) {
      return {};
    }
    visited.add(root?.step);

    // get all the parent nodes of current node (different events)
    const parentEvents = groupedTraceById[root.id];
    if (!parentEvents || parentEvents?.length < 1) return {};
    const precedentTree: Subtree = {};

    if (parentEvents) {
      const groupedParents = chain(parentEvents)
        .map((c, i) => ({ step: c.step, id: c.id, pId: c.pId }))
        .groupBy("pId")
        .value();

      forOwn(groupedParents, (parent, key) => {
        const event = find(parent, (c) => c.step <= root!.step);
        if (event && !precedentTree[event.step]) {
          // Use lodash findLastIndex to make TypeScript happy
          const index = findLastIndex(
            trace?.events,
            (e) => e?.id === event.pId
          );
          if (!isUndefined(index) && index >= 0) {
            const pEvent = { ...trace?.events?.[index], step: index } as Node;
            precedentTree[pEvent.step] = getPrecedentEvents(pEvent, visited);
          }
        }
      });
    }
    return precedentTree;
  };

  const showPrecedent = useCallback(
    (step: number) => {
      if (trace) {
        const current: Node = { ...(trace?.events ?? [])[step], step };
        const path = {
          [current.step]: getPrecedentEvents(current, new Set<number>()),
        };
        if (Object.keys(path[current.step]).length > 0) {
          setLayer(
            produce(layer, (l) =>
              set(l?.source!, "highlighting", {
                type: "precedent",
                step,
                path,
              })
            )!
          );
        } else {
          setLayer(produce(layer, (l) => set(l?.source!, "highlighting", {}))!);
        }
      }
    },
    [layer?.source?.highlighting, trace]
  );

  const groupedTraceBypId = chain(trace?.events)
    .map((c, i) => ({ step: i, id: c.id, pId: c.pId }))
    .groupBy("pId")
    .value();

  const getAllSubtreeNodes = (
    root: Node,
    visited = new Set<number | string>()
  ): Subtree => {
    if (visited.has(root.id)) {
      return {};
    }
    visited.add(root.id);
    // get all the child nodes of current node
    const children = groupedTraceBypId[root.id];
    if (!children || children.length < 1) return {};
    const subtree: Subtree = {};

    if (children) {
      const groupedChildren = chain(children)
        .map((c, i) => ({ step: c.step, id: c.id, pId: c.pId }))
        .groupBy("id")
        .value();

      forEach(groupedChildren, (child) => {
        const event = find(child, (c) => c.step >= root!.step);
        if (event && !subtree[event.step]) {
          subtree[event.step] = getAllSubtreeNodes(event, visited);
        }
      });
    }
    return subtree;
  };

  const showSubtree = useCallback(
    (step: number) => {
      const current: Node = { ...(trace?.events ?? [])[step], step };
      const path = {
        [current.step]: getAllSubtreeNodes(current, new Set<number>()),
      };
      if (Object.keys(path[current.step]).length > 0) {
        setLayer(
          produce(layer, (l) =>
            set(l?.source!, "highlighting", { type: "subtree", step, path })
          )!
        );
      } else {
        setLayer(produce(layer, (l) => set(l?.source!, "highlighting", {}))!);
      }
    },
    [layer?.source?.highlighting, trace]
  );

  return {
    backtracking: showBacktracking,
    subtree: showSubtree,
    precedent: showPrecedent,
    ["bounds-relevant"]: noop,
  };
}

export function flattenSubtree(subtree: Subtree) {
  let result: number[] = [];

  function traverse(tree: Subtree, path: number[]) {
    for (const key in tree) {
      const numericKey = Number(key);
      if (!result.includes(numericKey)) {
        result.push(numericKey);
      }
      if (typeof tree[key] === "object" && tree[key] !== null) {
        traverse(tree[key], path.concat(numericKey));
      }
    }
  }

  traverse(subtree, []);
  return result;
}
