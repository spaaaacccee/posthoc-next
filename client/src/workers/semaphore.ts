/**
 * Minimal counting semaphore, replacing `async-sema`.
 *
 * `async-sema` is CommonJS and reaches for Node's `events` builtin, which a
 * browser build externalizes into a plain object — its internal
 * `class ReleaseEmitter extends EventEmitter` then throws at module evaluation
 * ("Class extends value #<Object> is not a constructor") and takes the entire
 * bundle down before anything mounts.
 */

const brand = Symbol("permit");

/** An acquired permit. Opaque: only {@link Sema.release} does anything with it. */
export type Permit = { readonly [brand]: true };

export class Sema {
  private readonly held = new Set<Permit>();
  private readonly waiting: ((permit: Permit) => void)[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`Sema capacity must be a positive integer, got ${capacity}`);
    }
  }

  private issue(): Permit {
    const permit = { [brand]: true } as Permit;
    this.held.add(permit);
    return permit;
  }

  /** Permits available right now. */
  get free(): number {
    return this.capacity - this.held.size;
  }

  /** Take a permit if one is free, else `undefined`. Never blocks. */
  tryAcquire(): Permit | undefined {
    return this.free > 0 ? this.issue() : undefined;
  }

  /** Take a permit, waiting for one to be released if the semaphore is full. */
  acquire(): Promise<Permit> {
    const permit = this.tryAcquire();
    return permit
      ? Promise.resolve(permit)
      : new Promise((resolve) => void this.waiting.push(resolve));
  }

  /**
   * Give a permit back. Permits are identities rather than a bare count, so
   * releasing twice (or releasing something this semaphore never issued) is a
   * no-op instead of silently inflating the capacity.
   *
   * A freed permit goes straight to the longest-waiting caller, so `tryAcquire`
   * can never jump the queue and starve an `acquire` that is already blocked.
   */
  release(permit: Permit): void {
    if (!this.held.delete(permit)) return;
    this.waiting.shift()?.(this.issue());
  }
}
