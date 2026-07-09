import type {
  BreakpointProcessor,
  BreakpointProcessorOutput,
} from "components/breakpoint-editor/breakpoints/Breakpoint";
import processors from "components/breakpoint-editor/breakpoints/processors";
import { readAllEvents, SharedEventStore } from "components/renderer/parser-v140/sharedEventStore";
import { assert } from "utils/assert";
import type { BreakpointWorkerParameters } from "./BreakpointService";

export async function run({
  breakpoint: { type, properties: inputs = {} },
  trace,
  dict,
  store,
}: BreakpointWorkerParameters): BreakpointProcessorOutput {
  assert(type, "type is defined");
  // Shared path: reconstruct the events (at `content.events`) from the shared
  // bytes instead of receiving a clone of the whole trace.
  if (store && trace?.content) {
    trace = {
      ...trace,
      content: { ...trace.content, events: readAllEvents(new SharedEventStore(store)) },
    };
  }
  const processor = processors[type] as BreakpointProcessor<any>;
  return await processor(inputs, trace, dict);
}
