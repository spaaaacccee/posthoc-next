import { delay, now } from "es-toolkit/compat";

export function wait(ms: number) {
  return new Promise((res) => delay(res, ms));
}

/** Tells "the timeout won" apart from "the task resolved `undefined`". */
const TIMED_OUT = Symbol("timed-out");

export type Timed<T> = {
  result?: T;
  delta: number;
  /** Set when the task rejected. */
  error?: unknown;
  /** Set when `ms` elapsed before the task settled. */
  timedOut?: boolean;
};

/**
 * Runs `task`, giving up after `ms`.
 *
 * This used to race the task against the timeout with `Promise.any`, which ignores
 * rejections until *every* promise rejects. A task that threw therefore sat out the
 * full timeout and then resolved `{ result: undefined }`: the caller waited 2.5s to
 * be told nothing, and the reason was swallowed. A rejection now returns at once,
 * and carries its error.
 */
export async function timed<T>(task: () => Promise<T>, ms: number = 2500): Promise<Timed<T>> {
  const from = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      task(),
      new Promise<typeof TIMED_OUT>((res) => {
        timer = setTimeout(() => res(TIMED_OUT), ms);
      }),
    ]);
    return result === TIMED_OUT
      ? { delta: now() - from, timedOut: true }
      : { result: result as T, delta: now() - from };
  } catch (error) {
    return { error, delta: now() - from };
  } finally {
    // The loser of the race is abandoned, not cancelled, so without this its timer
    // holds the event loop open for the remainder of `ms`.
    clearTimeout(timer);
  }
}
