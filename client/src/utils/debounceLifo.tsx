type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Debounces an async function, and never lets two of its invocations overlap.
 *
 * A call made while an invocation is in flight is *withheld*, not run: only the
 * newest set of withheld arguments survives, and it goes once the in-flight
 * invocation settles. Intermediate calls are dropped, which is the point — this
 * exists to save an editor's buffer, where all that matters is that the last
 * thing typed is what lands.
 *
 * The returned promise settles with the invocation the call was folded into, so
 * a failing `f` is catchable by the caller rather than surfacing as a bare
 * unhandled rejection.
 *
 * It used to be built on `debounce` from `es-toolkit/compat`, which follows
 * lodash in returning the *previous* invocation's cached result rather than a
 * promise for the pending one. So `await` on it did not await the run it had
 * just scheduled — it awaited the one before, or `undefined` on the first call.
 * The in-flight gate therefore opened before `f` had even started, and none of
 * the serialization this function is for actually happened: two edits arriving
 * close together both ran, concurrently, against the same layer.
 */
export function debounceLifo<T extends (...args: any[]) => Promise<any>>(
  f: T,
  wait: number = 1000,
): (...args: Parameters<T>) => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued: { args: Parameters<T>; settled: Deferred } | undefined;

  const invoke = () => {
    if (running || !queued) return;
    const { args, settled } = queued;
    queued = undefined;
    running = true;
    f(...args)
      .then(settled.resolve, settled.reject)
      .finally(() => {
        running = false;
        // Only if the window has already elapsed. A call that arrived mid-flight
        // re-armed the timer, and firing here as well would run `f` while the
        // user is still typing — which is the debounce this function is meant
        // to be. If the timer already fired (it found us running, and did
        // nothing), nothing else is coming: run now, or the args are lost.
        if (queued && timer === undefined) invoke();
      });
  };

  return (...args: Parameters<T>) => {
    // Newest arguments win, and every call coalesced into this one settles with it.
    queued = { args, settled: queued?.settled ?? deferred() };
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      invoke();
    }, wait);
    return queued.settled.promise;
  };
}
