import { once } from "es-toolkit";
import { ceil, floor, forEach, map, throttle, times } from "es-toolkit/compat";
import { nanoid } from "nanoid";
import * as PIXI from "pixi.js";
import { Bounds } from "protocol";
import { LayerParams, makeRenderer, SharedComponentStore, SourceHandle } from "renderer";
import type Flatbush from "flatbush";
import { D2RendererBase } from "../d2-renderer-base/D2RendererBase";
import { bodyBounds, cacheIndex, cachedIndex, openIndex, queryVisible } from "./columnarIndex";
import {
  D2BodyHit,
  D2RendererOptions,
  defaultD2RendererOptions,
  nextResolutionScale,
} from "./D2RendererOptions";
import { D2V2WorkerEvents, getTiles } from "./D2RendererV2Worker";
import { D2RendererV2WorkerAdapter } from "./D2RendererV2WorkerAdapter";
import { hash } from "./hash";

function tileHash(bounds: Bounds) {
  return hash([bounds.top, bounds.right, bounds.bottom, bounds.left]);
}

/**
 * Bitmap tile sprite, positioned in world space.
 *
 * A tile **owns its texture**. `PIXI.Texture.from(bitmap)` mints a fresh
 * `BaseTexture` every call (PIXI can't cache-key an `ImageBitmap`), and PIXI
 * keeps uploaded base textures alive in `renderer.texture.managedTextures`, so
 * nothing is reclaimed by GC. Every texture this tile displaces — and every one
 * it declines — must therefore be destroyed explicitly, or a scrub leaks a
 * 256² GPU texture per tile per frame.
 */
class Tile extends PIXI.Sprite {
  static age: number = 0;
  /** Last use, as a monotonic tick — eviction takes the least recently used. Bump
   * it on *use*, not just on repaint: a tile whose content stops changing (a map
   * layer, a paused playhead) would otherwise grow arbitrarily old while it is
   * sitting on screen, and get evicted out from under the viewport. */
  age: number = Tile.age++;
  touch() {
    this.age = Tile.age++;
  }
  /** Whether a worker has rasterized this tile's current content. */
  resolved: boolean = false;
  #update(texture: PIXI.Texture, hash: string) {
    const prev = this.texture;
    const scale = {
      x: (this.bounds.right - this.bounds.left) / texture.width,
      y: (this.bounds.bottom - this.bounds.top) / texture.height,
    };
    this.texture = texture;
    this.setTransform(this.bounds.left, this.bounds.top, scale.x, scale.y);
    this.touch();
    this.hash = hash;
    // `super(texture)` already assigned the same texture on the ctor path.
    if (prev && prev !== texture && prev !== PIXI.Texture.EMPTY) prev.destroy(true);
  }
  reuse(texture: PIXI.Texture, hash: string) {
    if (
      this.hash === hash &&
      this.texture.width * this.texture.height > texture.width * texture.height
    ) {
      // Keeping the higher-resolution texture we already have — but the caller
      // minted this one for us, so it's ours to dispose of.
      texture.destroy(true);
      return;
    }
    this.#update(texture, hash);
  }
  override destroy() {
    super.destroy({ texture: true, baseTexture: true });
  }
  constructor(
    texture: PIXI.Texture,
    public bounds: Bounds,
    public key: string,
    public hash?: string,
  ) {
    super(texture);
    this.name = this.key;
    this.#update(texture, hash ?? nanoid());
  }
}

/**
 * How many tiles to keep, as a multiple of a frustum's worth. Tiles were
 * previously only ever added, so panning and zooming accumulated a live sprite
 * (and, now, a live GPU texture) for every tile of every zoom level ever
 * visited. A couple of screens of pan history is enough to make backtracking
 * feel instant.
 */
const TILE_BUDGET = 4;
const MIN_TILE_BUDGET = 64;

type Layer = {
  store: SharedComponentStore;
  index?: SharedArrayBuffer;
  fb?: Flatbush;
  params: LayerParams;
};

/**
 * Main-thread half of the v2 renderer. Owns the PIXI viewport + tile sprites and
 * a fleet of v2 workers. Instead of fanning cloned components (v1 `add`), it
 * `load()`s an immutable {@link SharedComponentStore}: the shared Flatbush is
 * built once and handed to every worker (SAB, no clone), and the playhead drives
 * visibility via `setStep`. Hover/click query the same shared index — there is
 * no per-renderer rbush copy.
 */
export class D2RendererV2 extends D2RendererBase {
  declare protected app?: PIXI.Application<HTMLCanvasElement>;
  protected options: D2RendererOptions = defaultD2RendererOptions;

  #tiles?: PIXI.Container<Tile>;
  /** Tiles by key. The container owns render order; this owns lookup — scanning
   * `#tiles.children` per update made tile bookkeeping quadratic. */
  #tileIndex = new Map<string, Tile>();
  #grid?: PIXI.Graphics;
  #workers: D2RendererV2WorkerAdapter[] = [];
  #step = 0;

  #layers = new Map<SourceHandle, Layer>();
  /** Handles whose index worker 0 is currently packing → the store it's for. */
  #pendingIndex = new Map<SourceHandle, SharedComponentStore>();

  protected override setupPixi(o: D2RendererOptions) {
    super.setupPixi(o);
    if (!this.viewport) return;
    this.#tiles = new PIXI.Container();
    this.#tiles.sortableChildren = true;
    this.viewport.addChild(this.#tiles);
    this.#grid = new PIXI.Graphics();
    this.viewport.addChild(this.#grid);
    this.#startDynamicResolution();
    this.viewport.on("mousemove", (e) => this.#queueHover(e));
    this.viewport.on("moved", () => this.#getUpdateGridQueue()());
    this.viewport.on("clicked", (e) => this.#click(e));
  }

  /**
   * Report the bodies under the pointer as (layer, index) pairs.
   *
   * The base class also fires `click` here, but it resolves against `this.system`
   * — the rbush the v1 `add()` path fills, which v2 leaves empty — so that event
   * carries nothing. This queries the same shared Flatbush the renderer draws
   * from, so hit-testing needs no second index and no per-body objects.
   *
   * Topmost first: bodies draw in ascending index order, so the highest index is
   * the one on top. A graph packs edges before nodes precisely so that clicking
   * where a node overlaps its edge selects the node.
   */
  #click(e: { world: PIXI.Point; event: Event }) {
    const { x, y } = e.world;
    const point = { left: x, top: y, right: x + Number.MIN_VALUE, bottom: y + Number.MIN_VALUE };
    const bodies: D2BodyHit[] = [];
    for (const [handle, layer] of this.#layers) {
      if (!layer.fb) continue;
      for (const i of queryVisible(layer.store, layer.fb, point, this.#step, { sort: false })) {
        bodies.push({ handle, index: i });
      }
    }
    bodies.sort((a, b) => b.index - a.index);
    this.emit("clickBody", e.event, { world: { x, y }, bodies });
  }

  setup(options: Partial<D2RendererOptions>) {
    super.setup(options);
    this.#handleWorkerChange(this.options);
  }

  destroy(): void {
    map(this.#workers, (w) => w.terminate());
    if (this.#hoverFrame !== undefined) cancelAnimationFrame(this.#hoverFrame);
    for (const t of this.#tileIndex.values()) t.destroy();
    this.#tileIndex.clear();
    super.destroy();
  }

  // v2 uses load(); add() is intentionally inert so a stray legacy call is a
  // no-op rather than silently populating the (unused) main-thread rbush.
  override add() {
    return () => {};
  }

  /**
   * Load an immutable generation.
   *
   * Packing the Flatbush is O(n log n) with a bbox per body, so it does not
   * happen here — worker 0 does it and hands the buffer back (see
   * {@link #handleIndex}). Until it arrives the layer has no `fb` and simply
   * draws nothing; the workers already handle an index-less layer. The one case
   * that stays synchronous is a store we've indexed before: re-`load()`ing the
   * same store (the viewport remounting against a cached store) must not blink.
   */
  load(store: SharedComponentStore, params: LayerParams = {}): SourceHandle {
    const id = nanoid();
    const { hit, index } = cachedIndex(store);
    this.#layers.set(id, { store, index, fb: index ? openIndex(index) : undefined, params });
    this.#workers.forEach((w) =>
      w.call("setLayer", [id, { store, index, generation: store.generation }, params]),
    );
    if (!hit) {
      this.#pendingIndex.set(id, store);
      this.#workers[0]?.call("buildLayerIndex", [id]);
    }
    this.#clearResolved();
    // Push the current frustum + step so freshly-loaded workers render the
    // visible region immediately instead of their default 256² frustum.
    this.handleFrustumChange();
    this.#workers.forEach((w) => w.call("setStep", [this.#step]));
    return id;
  }

  unload(handle: SourceHandle): void {
    this.#layers.delete(handle);
    this.#pendingIndex.delete(handle);
    this.#workers.forEach((w) => w.call("removeLayer", [handle]));
    this.#clearResolved();
  }

  #handleIndex({ handle, index }: D2V2WorkerEvents["index"]) {
    const store = this.#pendingIndex.get(handle);
    this.#pendingIndex.delete(handle);
    // Memoize against the store, not the handle: this is what makes a remount
    // against the same (react-query cached) store take the synchronous path.
    if (store) cacheIndex(store, index);
    const layer = this.#layers.get(handle);
    if (!layer) return; // unloaded while the index was being packed
    layer.index = index;
    layer.fb = index ? openIndex(index) : undefined;
    this.#workers.forEach((w) => w.call("setLayerIndex", [handle, index]));
    this.#clearResolved();
    this.handleFrustumChange();
  }

  #clearResolved() {
    for (const t of this.#tileIndex.values()) t.resolved = false;
  }

  setStep(step: number): void {
    if (step === this.#step) return;
    this.#step = step;
    this.#workers.forEach((w) => w.call("setStep", [step]));
  }

  setLayerParams(handle: SourceHandle, params: LayerParams): void {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.params = { ...layer.params, ...params };
    this.#workers.forEach((w) => w.call("setLayerParams", [handle, params]));
  }

  // Fit to the union of the selected layers' bounds. There is no per-body rbush
  // in v2, so bounds come from each layer's shared Flatbush; the ViewportPage
  // predicate only reads `meta.sourceLayer`, so a synthetic body per layer
  // decides inclusion.
  override fitCamera(
    fn: (body: { meta?: { sourceLayer?: string } }) => boolean = () => true,
  ): void {
    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;
    let any = false;
    for (const layer of this.#layers.values()) {
      if (!layer.fb) continue;
      if (!fn({ meta: { sourceLayer: layer.params.sourceLayer } })) continue;
      any = true;
      top = Math.min(top, layer.fb.minY);
      left = Math.min(left, layer.fb.minX);
      bottom = Math.max(bottom, layer.fb.maxY);
      right = Math.max(right, layer.fb.maxX);
    }
    if (!any || !this.viewport) return;
    this.viewport.animate?.({
      position: new PIXI.Point((left + right) / 2, (top + bottom) / 2),
      scale: (this.viewport.findFit?.(right - left, bottom - top) ?? 1) * 0.8,
      ease: "easeOutExpo",
      time: this.options.animationDuration * 1.5,
      callbackOnComplete: () => this.handleFrustumChange(),
    });
  }

  #handleWorkerChange(options: D2RendererOptions) {
    map(this.#workers, (w) => w.terminate());
    this.#workers = times(options.workerCount, (i) => {
      const worker = new D2RendererV2WorkerAdapter();
      worker.on("update", (e) => this.#handleUpdate(e));
      if (i === 0) worker.on("index", (e) => this.#handleIndex(e));
      worker.onerror = (e) => {
        throw e;
      };
      worker.call("setup", [{ ...options, workerIndex: i }]);
      return worker;
    });
  }

  #startDynamicResolution() {
    const { dynamicResolution } = this.options;
    const { intervalMs, minScale } = dynamicResolution;
    const targetFrames = floor(PIXI.Ticker.targetFPMS * intervalMs);
    let frames = 0;
    let cdt = 0;
    let scale = minScale;
    this.app!.ticker.add((dt) => {
      const { tileResolution } = this.options;
      if (!(frames % targetFrames)) {
        const adt = cdt / targetFrames;
        scale = nextResolutionScale(scale, adt, dynamicResolution);
        map(this.#workers, (w) =>
          w.call("setTileResolution", [
            {
              width: ceil(tileResolution.width / scale),
              height: ceil(tileResolution.height / scale),
            },
          ]),
        );
        cdt = 0;
      }
      cdt += dt;
      frames++;
    });
  }

  protected override handleWindowSizeChange(options: D2RendererOptions) {
    super.handleWindowSizeChange(options);
    map(this.#workers, (w) =>
      w.call("setTileResolution", [
        { width: ceil(options.tileResolution.width), height: ceil(options.tileResolution.height) },
      ]),
    );
  }

  protected override handleFrustumChange() {
    if (!this.viewport) return;
    const { top, bottom, left, right } = this.viewport;
    map(this.#workers, (w) => w.call("setFrustum", [{ top, bottom, left, right }]));
  }

  #handleUpdate({ bounds, bitmap, hash: nextHash }: D2V2WorkerEvents["update"]) {
    const texture = bitmap ? PIXI.Texture.from(bitmap) : undefined;
    this.#addToWorld(bounds, nextHash, texture);
  }

  #addToWorld(bounds: Bounds, nextHash: string, texture?: PIXI.Texture) {
    if (!this.viewport) return;
    const tileKey = tileHash(bounds);
    let tile = this.#tileIndex.get(tileKey);
    if (texture) {
      if (tile) tile.reuse(texture, nextHash);
      else {
        tile = new Tile(texture, bounds, tileKey, nextHash);
        this.#tiles!.addChild(tile);
        this.#tileIndex.set(tileKey, tile);
        this.#evictTiles();
      }
    } else if (!tile) {
      // A bitmap-less update means "unchanged — you already have this one", but we
      // don't: we evicted it, and the worker hasn't been told (or was told after it
      // had already answered). Ask again, or the tile stays a placeholder forever —
      // nothing else will ever change its content hash except the playhead moving.
      this.#dropTiles([bounds]);
    }
    if (tile) {
      tile.resolved = true;
      tile.touch();
    }
    this.#getUpdateGridQueue()();
  }

  /**
   * Drop the least recently used tiles once we're over budget, destroying their
   * textures — and tell the workers, whose content-hash cache is a record of what
   * *we* hold. A worker that still believes we have a tile will never re-send it.
   */
  #evictTiles() {
    if (!this.viewport) return;
    const frustum = getTiles(this.viewport, this.options.tileSubdivision, false).tiles.length;
    const budget = Math.max(MIN_TILE_BUDGET, frustum * TILE_BUDGET);
    const dropped: Bounds[] = [];
    while (this.#tileIndex.size > budget) {
      let oldest: Tile | undefined;
      for (const t of this.#tileIndex.values()) {
        if (!oldest || t.age < oldest.age) oldest = t;
      }
      if (!oldest) break;
      this.#tileIndex.delete(oldest.key);
      this.#tiles?.removeChild(oldest);
      dropped.push(oldest.bounds);
      oldest.destroy();
    }
    if (dropped.length) this.#dropTiles(dropped);
  }

  /** Tiles we no longer hold. Broadcast: only the worker that owns a given tile
   * has it cached, and only that worker will re-render it. */
  #dropTiles(bounds: Bounds[]) {
    this.#workers.forEach((w) => w.call("dropTiles", [bounds]));
  }

  #getUpdateGridQueue = once(() =>
    throttle(() => this.#updateGrid(), this.options.refreshInterval),
  );

  #updateGrid() {
    if (!this.viewport) return;
    const { tileSubdivision, accentColor } = this.options;
    const { tiles } = getTiles(this.viewport, tileSubdivision, false);
    const px = this.getPx();
    this.#grid?.clear();
    this.#grid?.lineStyle(1 * px, accentColor, 0.5);
    this.#grid?.beginFill(accentColor, 0.05);
    forEach(this.#tiles?.children, (t) => (t.zIndex = 0));
    let numResolved = 0;
    for (const { bounds: b } of tiles) {
      const t = this.#tileIndex.get(tileHash(b));
      // On screen — so, in use. Keeps the frustum out of reach of the evictor,
      // which would otherwise be free to take a tile the user is looking at.
      t?.touch();
      if (t?.resolved) {
        t.zIndex = 1;
        t.visible = true;
        numResolved++;
      }
      if (!t) this.#grid?.drawRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    }
    if (numResolved === tiles.length) {
      forEach(this.#tiles?.children, (t) => {
        if (t.zIndex === 0) t.visible = false;
      });
    }
  }

  // Hover ran a spatial query + a full overlay rebuild on every raw mousemove.
  // Coalesce to one per frame — rAF rather than a throttle, so the rebuild lands
  // on the frame that will actually display it.
  #hoverEvent?: PIXI.FederatedPointerEvent;
  #hoverFrame?: number;
  #queueHover(e: PIXI.FederatedPointerEvent) {
    this.#hoverEvent = e;
    this.#hoverFrame ??= requestAnimationFrame(() => {
      this.#hoverFrame = undefined;
      if (this.#hoverEvent) this.#updateHover(this.#hoverEvent);
    });
  }

  #updateHover(e: PIXI.FederatedPointerEvent) {
    if (!this.viewport || !this.overlay || !this.#layers.size) return;
    const { accentColor } = this.options;
    const px = this.getPx();
    const { x, y } = this.viewport.toWorld(e.globalX, e.globalY);
    const point = { left: x, top: y, right: x + Number.MIN_VALUE, bottom: y + Number.MIN_VALUE };
    this.overlay.clear();
    this.overlay.lineStyle(2 * px, accentColor, 0.5);
    for (const layer of this.#layers.values()) {
      if (!layer.fb) continue;
      // Unsorted: hit-testing doesn't care about draw order.
      for (const i of queryVisible(layer.store, layer.fb, point, this.#step, { sort: false })) {
        const [minX, minY, maxX, maxY] = bodyBounds(layer.store, i);
        this.overlay.drawRect(minX, minY, maxX - minX, maxY - minY);
      }
    }
  }
}

export default makeRenderer(D2RendererV2, {
  // Component `$` kinds, as in v1. Labels are drawn (as their own store bodies),
  // but `text` is an attribute of these components, never a `$` of its own.
  components: ["rect", "circle", "path", "polygon"],
  id: "d2-renderer",
  name: "Pixel",
  description: "Comfortably performant 2D renderer",
  version: "2.0.0",
  supportsLoad: true,
});
