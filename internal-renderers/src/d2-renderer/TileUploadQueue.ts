import type { Bounds } from "protocol";

/** The minimum a queued bitmap has to be: something that owns pixels we can release. */
export type Closeable = { close(): void };

export type PendingUpload<T> = { bounds: Bounds; hash: string; bitmap: T };

/**
 * Tile bitmaps waiting to go to the GPU, at most one per tile, drained under a
 * per-frame budget.
 *
 * A worker emits a bitmap for every tile whose content changed, as soon as it has
 * it. The main thread then has to receive each one, point a texture at it and let
 * PIXI upload it — and that work lands in the same frame budget as the rest of the
 * UI. So a burst of dirty tiles (a scrub, a pan, a zoom across an octave) could
 * blow a frame on uploads alone, and there was nothing to stop it.
 *
 * The queue does two things about that:
 *
 * - **Supersedes.** Only the newest bitmap per tile is worth uploading; an older
 *   one that never reached the GPU is dead the moment a newer one arrives, so it
 *   is closed on the spot. An `ImageBitmap` owns off-heap pixels that GC reclaims
 *   lazily, and a scrub mints one per dirty tile per frame — leaving them to the
 *   collector means holding megabytes of decoded bitmap nobody will ever draw.
 *
 * - **Budgets.** {@link drain} uploads at most `budget` tiles per call. The rest
 *   wait for the next frame. The renderer therefore falls *behind* under load
 *   rather than dragging the frame rate down with it, which is the trade we want:
 *   a viewport that lags the playhead by a frame or two is fine, a UI that stutters
 *   is not.
 *
 * Everything queued is a tile the worker chose to render, and workers only render
 * the frustum — so insertion order is already "what is on screen", and needs no
 * further prioritisation.
 */
export class TileUploadQueue<T extends Closeable> {
  #pending = new Map<string, PendingUpload<T>>();

  constructor(private readonly key: (bounds: Bounds) => string) {}

  /** Queue a tile's newest bitmap, releasing any it displaces. */
  push(bounds: Bounds, hash: string, bitmap: T) {
    const k = this.key(bounds);
    const displaced = this.#pending.get(k);
    // Superseded before it was ever uploaded: nothing will draw it now.
    if (displaced && displaced.bitmap !== bitmap) displaced.bitmap.close();
    this.#pending.set(k, { bounds, hash, bitmap });
  }

  /** Whether a newer bitmap for this tile is already waiting. */
  has(bounds: Bounds) {
    return this.#pending.has(this.key(bounds));
  }

  /**
   * Upload at most `budget` tiles, oldest first. Returns how many were applied.
   * A non-positive budget drains everything — the escape hatch for a caller that
   * would rather stall than show a stale frustum.
   */
  drain(budget: number, apply: (upload: PendingUpload<T>) => void): number {
    let applied = 0;
    for (const [k, upload] of this.#pending) {
      if (budget > 0 && applied >= budget) break;
      this.#pending.delete(k);
      apply(upload);
      applied++;
    }
    return applied;
  }

  /** Drop everything, releasing the bitmaps. For teardown. */
  clear() {
    for (const { bitmap } of this.#pending.values()) bitmap.close();
    this.#pending.clear();
  }

  get size() {
    return this.#pending.size;
  }
}
