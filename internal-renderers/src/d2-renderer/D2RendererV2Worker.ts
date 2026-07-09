import { once, throttle } from "es-toolkit/compat";
import type { Bounds, Point, Size } from "protocol";
import type { SharedComponentStore } from "renderer";
import type Flatbush from "flatbush";
import { columnarDrawTransform, drawBody } from "./columnarDraw";
import { openIndex, queryVisible } from "./columnarIndex";
import { D2RendererEvents, D2RendererOptions, defaultD2RendererOptions } from "./D2RendererOptions";
import { getTiles } from "./D2RendererWorker";
import { EventEmitter } from "./EventEmitter";
import { hash } from "./hash";
import { pointToIndex } from "./pointToIndex";

export type D2V2WorkerEvents = {
  update: {
    bounds: Bounds;
    bitmap?: ImageBitmap;
    hash: string;
    isError?: boolean;
  };
};

export type D2V2WorkerEvent<T extends keyof D2V2WorkerEvents = keyof D2V2WorkerEvents> = {
  action: T;
  payload: D2V2WorkerEvents[T];
};

/** A complete, immutable generation handed from the main thread in one message. */
export type Generation = {
  store: SharedComponentStore;
  /** Flatbush backing buffer (SharedArrayBuffer); absent when the store is empty. */
  index?: SharedArrayBuffer;
  generation: number;
};

type OpenGeneration = Generation & { fb?: Flatbush; colors: Map<number, string> };

const MAX_TILE_CACHE = 512;

/**
 * v2 render worker. Holds one *immutable generation* (columnar store + shared
 * Flatbush) and rasterizes the tiles it owns. Visibility is decoupled: a tile's
 * content = spatial hits ∩ `start <= step < end`. Swapping generations is a
 * single reference assignment in a message handler, so it is atomic w.r.t. an
 * in-flight (synchronous) tile render — no torn read, no lock needed.
 */
export class D2RendererV2Worker extends EventEmitter<
  D2RendererEvents & {
    message: (event: D2V2WorkerEvent, transfer: Transferable[]) => void;
  }
> {
  #options: D2RendererOptions = defaultD2RendererOptions;
  #frustum: Bounds = { bottom: 256, top: 0, left: 0, right: 256 };
  #gen?: OpenGeneration;
  #step = 0;
  #now = 0;

  // Tile cache: tileKey -> {hash, tile size}. Insertion-ordered for LRU.
  #cache = new Map<string, { hash: string; width: number; height: number }>();

  setup(options: D2RendererOptions) {
    this.#options = options;
    this.#invalidate();
  }

  setFrustum(frustum: Bounds) {
    this.#frustum = frustum;
    this.#getRenderQueue()();
  }

  setTileResolution(tileResolution: Size) {
    this.#options = { ...this.#options, tileResolution };
    this.#cache.clear();
    this.#invalidate();
  }

  setStep(step: number) {
    if (step === this.#step) return;
    this.#step = step;
    this.#now++;
    this.#invalidate();
  }

  /** Swap in a new generation (or clear with `undefined`). Old gen is dropped. */
  setGeneration(gen?: Generation) {
    this.#gen = gen
      ? { ...gen, fb: gen.index ? openIndex(gen.index) : undefined, colors: new Map() }
      : undefined;
    this.#cache.clear();
    this.#now++;
    this.#invalidate();
  }

  #invalidate() {
    this.#getRenderQueue()();
  }

  #getRenderQueue = once(() =>
    throttle(() => this.render(), this.#options.refreshInterval, {
      leading: false,
      trailing: true,
    }),
  );

  #shouldRender({ x, y }: Point) {
    const { workerCount, workerIndex } = this.#options;
    return (this.#now + pointToIndex({ x, y })) % workerCount === workerIndex;
  }

  #touch(tileKey: string, value: { hash: string; width: number; height: number }) {
    this.#cache.delete(tileKey);
    this.#cache.set(tileKey, value);
    if (this.#cache.size > MAX_TILE_CACHE) {
      // Evict least-recently-used (front of insertion order).
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }

  render() {
    const gen = this.#gen;
    if (!gen?.fb) return;
    for (const { tile, bounds } of getTiles(this.#frustum, this.#options.tileSubdivision).tiles) {
      if (this.#shouldRender(tile)) {
        const out = this.#renderTile(gen, bounds, this.#options.tileResolution);
        if (out) {
          this.emit(
            "message",
            { action: "update", payload: { bounds, bitmap: out.bitmap, hash: out.hash } },
            out.bitmap ? [out.bitmap] : [],
          );
        }
      }
    }
  }

  #renderTile(
    gen: OpenGeneration,
    bounds: Bounds,
    tile: Size,
  ): { hash: string; bitmap?: ImageBitmap } | undefined {
    const { store, fb } = gen;
    if (!fb) return undefined;
    const { top, right, bottom, left } = bounds;

    const indices = queryVisible(store, fb, { top, left, right, bottom }, this.#step);
    // Content key is generation + the visible body indices: correct under any
    // visibility state and dedups identical tiles across steps.
    const nextHash = hash([gen.generation, ...indices]);
    const tileKey = hash([top, right, bottom, left, tile.width, tile.height]);

    const prev = this.#cache.get(tileKey);
    if (
      prev &&
      prev.hash === nextHash &&
      prev.width + prev.height >= tile.width + tile.height
    ) {
      return { hash: prev.hash };
    }

    const g = new OffscreenCanvas(tile.width, tile.height);
    const ctx = g.getContext("2d", { alpha: false })!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.#options.backgroundColor;
    ctx.fillRect(0, 0, tile.width, tile.height);

    const t = columnarDrawTransform(bounds, tile);
    for (const i of indices) drawBody(store, i, ctx, t, gen.colors);

    const bitmap = g.transferToImageBitmap();
    this.#touch(tileKey, { hash: nextHash, width: bitmap.width, height: bitmap.height });
    return { hash: nextHash, bitmap };
  }

  /** For tests: current tile-cache size. */
  get cacheSize() {
    return this.#cache.size;
  }
}

// Re-exported so the main thread can build the same tile grid if needed.
export { getTiles };
