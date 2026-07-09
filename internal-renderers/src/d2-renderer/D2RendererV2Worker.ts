import { once, throttle } from "es-toolkit/compat";
import type { Bounds, Point, Size } from "protocol";
import type { LayerParams, SharedComponentStore } from "renderer";
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

type OpenLayer = Generation & {
  fb?: Flatbush;
  colors: Map<number, string>;
  params: LayerParams;
};

const MAX_TILE_CACHE = 512;

/**
 * v2 render worker. Holds a set of *immutable layers* (each a columnar store +
 * shared Flatbush + compositing params) keyed by a handle, and rasterizes the
 * tiles it owns. Per tile, layers are drawn in `params.index` order onto their
 * own sub-canvas and composited (alpha + displayMode) — so toggling a layer or
 * changing its opacity is a param update, never a rebuild. Visibility is
 * decoupled: a layer's tile content = spatial hits ∩ `start <= step < end`.
 *
 * Swapping a layer is a single Map write in a message handler, atomic w.r.t. an
 * in-flight synchronous tile render — no torn read, no lock; disposal is a delete.
 */
export class D2RendererV2Worker extends EventEmitter<
  D2RendererEvents & {
    message: (event: D2V2WorkerEvent, transfer: Transferable[]) => void;
  }
> {
  #options: D2RendererOptions = defaultD2RendererOptions;
  #frustum: Bounds = { bottom: 256, top: 0, left: 0, right: 256 };
  #layers = new Map<string, OpenLayer>();
  #step = 0;
  #now = 0;

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

  /** Add or replace a layer's generation. */
  setLayer(handle: string, gen: Generation, params: LayerParams = {}) {
    this.#layers.set(handle, {
      ...gen,
      fb: gen.index ? openIndex(gen.index) : undefined,
      colors: new Map(),
      params,
    });
    this.#cache.clear();
    this.#now++;
    this.#invalidate();
  }

  removeLayer(handle: string) {
    if (this.#layers.delete(handle)) {
      this.#cache.clear();
      this.#now++;
      this.#invalidate();
    }
  }

  /** Update a layer's compositing params (order/alpha/displayMode) — no rebuild. */
  setLayerParams(handle: string, params: LayerParams) {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.params = { ...layer.params, ...params };
    this.#cache.clear();
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
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }

  /** Layers with a built index, in draw order (higher `index` on top). */
  #orderedLayers() {
    return [...this.#layers.values()]
      .filter((l) => l.fb)
      .sort((a, b) => (a.params.index ?? 0) - (b.params.index ?? 0));
  }

  render() {
    // Note: no layer guard. Empty tiles still paint the background + centre
    // notch, which is the only cue that panning is doing anything when nothing
    // is loaded (or you've panned off the content).
    for (const { tile, bounds } of getTiles(this.#frustum, this.#options.tileSubdivision).tiles) {
      if (this.#shouldRender(tile)) {
        const out = this.#renderTile(bounds, this.#options.tileResolution);
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

  /**
   * A faint crosshair at each tile's centre. With an empty (or panned-away)
   * viewport this is the only thing that moves, so the user can tell the drag is
   * registering. Geometry matches v1's notch.
   */
  #drawNotch(ctx: OffscreenCanvasRenderingContext2D, tile: Size) {
    const length = tile.width * 0.05;
    const thickness = 1;
    ctx.fillStyle = `rgba(127,127,127,0.36)`;
    ctx.fillRect((tile.width - length) / 2, (tile.height - thickness) / 2, length, thickness);
    ctx.fillRect((tile.width - thickness) / 2, (tile.height - length) / 2, thickness, length);
  }

  #renderTile(bounds: Bounds, tile: Size): { hash: string; bitmap?: ImageBitmap } | undefined {
    const layers = this.#orderedLayers();
    const { top, right, bottom, left } = bounds;

    // Visible bodies per layer + a content hash over (generation, visible ids).
    // A sentinel (-1) separates layers so distinct splits can't collide.
    const perLayer = layers.map((l) => ({
      l,
      indices: queryVisible(l.store, l.fb!, { top, left, right, bottom }, this.#step),
    }));
    const hashInput: number[] = [];
    for (const { l, indices } of perLayer) {
      hashInput.push(-1, l.generation, indices.length, ...indices);
    }
    const nextHash = hash(hashInput);
    const tileKey = hash([top, right, bottom, left, tile.width, tile.height]);

    const prev = this.#cache.get(tileKey);
    if (prev && prev.hash === nextHash && prev.width + prev.height >= tile.width + tile.height) {
      return { hash: prev.hash };
    }

    const g = new OffscreenCanvas(tile.width, tile.height);
    const ctx = g.getContext("2d", { alpha: false })!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.#options.backgroundColor;
    ctx.fillRect(0, 0, tile.width, tile.height);
    this.#drawNotch(ctx, tile);

    const t = columnarDrawTransform(bounds, tile);
    for (const { l, indices } of perLayer) {
      if (!indices.length) continue;
      // Each layer paints onto its own sub-canvas, then composites with its
      // alpha + blend mode (matching v1's per-source-layer compositing).
      const g2 = new OffscreenCanvas(tile.width, tile.height);
      const ctx2 = g2.getContext("2d")!;
      for (const i of indices) drawBody(l.store, i, ctx2, t, l.colors);
      ctx.globalAlpha = l.params.alpha ?? 1;
      ctx.globalCompositeOperation = l.params.displayMode ?? "source-over";
      ctx.drawImage(g2, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const bitmap = g.transferToImageBitmap();
    this.#touch(tileKey, { hash: nextHash, width: bitmap.width, height: bitmap.height });
    return { hash: nextHash, bitmap };
  }

  /** For tests: current tile-cache size. */
  get cacheSize() {
    return this.#cache.size;
  }
}

export { getTiles };
