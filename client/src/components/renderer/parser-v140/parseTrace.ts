import { useSnackbar } from "components/generic/Snackbar";
import { get } from "lodash-es";
import pluralize from "pluralize";
import { useMemo } from "react";
import { useLoadingState } from "slices/loading";
import { usingMemoizedWorkerTask } from "workers/usingWorker";
import parseTraceWorkerLegacyUrl from "../parser/parseTrace.worker.ts?worker&url";
import {
  ParseTraceWorkerParameters as ParseTraceWorkerLegacyParameters,
  ParseTraceWorkerReturnType as ParseTraceWorkerLegacyReturnType,
} from "../parser/ParseTraceSlaveWorker";
import parseTraceWorkerUrl from "./parseTrace.worker.ts?worker&url";
import {
  ParseTraceWorkerParameters,
  ParseTraceWorkerReturnType,
} from "./ParseTraceSlaveWorker";

export class ParseTraceWorker extends Worker {
  constructor() {
    super(parseTraceWorkerUrl, { type: "module" });
  }
}
export class ParseTraceWorkerLegacy extends Worker {
  constructor() {
    super(parseTraceWorkerLegacyUrl, { type: "module" });
  }
}

export const parseTraceAsync = usingMemoizedWorkerTask<
  ParseTraceWorkerParameters,
  ParseTraceWorkerReturnType
>(ParseTraceWorker);

export const parseTraceLegacyAsync = usingMemoizedWorkerTask<
  ParseTraceWorkerLegacyParameters,
  ParseTraceWorkerLegacyReturnType
>(ParseTraceWorkerLegacy);

export function useTraceParser(
  params: ParseTraceWorkerParameters | ParseTraceWorkerLegacyParameters,
  trusted: boolean,
  deps: any[]
) {
  const push = useSnackbar();
  const usingLoadingState = useLoadingState("layers");
  return useMemo(() => {
    if (params.trace) {
      return trusted
        ? () =>
            usingLoadingState(async () => {
              push("Processing trace...");
              try {
                const output =
                  params.trace?.version === "1.4.0"
                    ? await parseTraceAsync(
                        params as ParseTraceWorkerParameters
                      )
                    : await parseTraceLegacyAsync(
                        params as ParseTraceWorkerLegacyParameters
                      );
                push(
                  "Trace loaded",
                  pluralize("step", output?.stepsPersistent?.length ?? 0, true)
                );
                return { components: output, content: params.trace };
              } catch (e) {
                console.error(e);
                push("Error parsing", get(e, "message"));
                return { error: get(e, "message") };
              }
            })
        : () =>
            usingLoadingState(async () => {
              push(
                "Trace loaded",
                pluralize("step", params.trace?.events?.length ?? 0, true)
              );
              return {
                content: params.trace,
                components: {
                  stepsPersistent: [],
                  stepsTransient: [],
                },
              };
            });
    } else {
      return undefined;
    }
    // eslint-disable-next-line react-compiler/react-compiler
  }, deps);
}
