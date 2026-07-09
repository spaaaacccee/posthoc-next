import { Trace } from "protocol/Trace-v140";
import { slice } from "slices";
import { upgradeTrace } from "./upgradeTrace";

/**
 * Every trace enters the app through here, whichever door it came in by —
 * file import, source editing, a solve result, or a connection fetch. Anything
 * older than v1.4.0 is upgraded on the spot, so the rest of the app only ever
 * sees one trace format.
 *
 * Results are cached by identity: the same raw object always yields the same
 * upgraded object (keeping React deps and memo keys stable) and is announced to
 * the log exactly once, however many times it is read.
 */
const cache = new WeakMap<object, Trace>();

const write = (content: string) =>
  slice.log.append({
    content,
    timestamp: `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
  });

export function readTrace(content: unknown): Trace | undefined {
  if (!content || typeof content !== "object") return undefined;
  const cached = cache.get(content);
  if (cached) return cached;

  const { trace, from, warnings } = upgradeTrace(content as Trace);
  if (from) {
    write(`Converted trace from version ${from} to 1.4.0.`);
  }
  for (const warning of warnings) {
    write(`Trace conversion: ${warning}`);
  }
  // Shallow-freeze so immer's auto-freeze treats the trace as an opaque leaf:
  // `freeze()` early-returns on an already-frozen object and never recurses, so
  // committing this (huge) event graph to the layers store no longer
  // deep-freezes every event on the main thread.
  if (trace) Object.freeze(trace);
  cache.set(content, trace);
  return trace;
}
