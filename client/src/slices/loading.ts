import { some, values } from "lodash";
import { useCallback } from "react";
import { createSlice } from "./createSlice";
import { produce } from "produce";

type Loading = {
  layers: number;
  connections: number;
  features: number;
  general: number;
};

type A = { action: "start" | "end"; key: keyof Loading };

export const [useLoading, LoadingProvider] = createSlice<Loading, A>(
  {
    layers: 0,
    connections: 0,
    features: 0,
    general: 0,
  },
  {
    reduce: (prev, { action, key }: A) => {
      return produce(prev, (draft) => {
        switch (action) {
          case "start":
            draft[key] += 1;
            break;
          case "end":
            draft[key] -= 1;
        }
        return draft;
      });
    },
  }
);

export function useAnyLoading() {
  const [loading] = useLoading();
  return some(values(loading));
}

export function useLoadingState(key: keyof Loading = "general") {
  const [, dispatch] = useLoading();

  return useCallback(
    async <T>(task: () => Promise<T>) => {
      dispatch(() => ({ action: "start", key }));
      const out = await task();
      dispatch(() => ({ action: "end", key }));
      return out;
    },
    [key, dispatch]
  );
}
