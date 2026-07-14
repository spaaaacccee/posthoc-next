import { once } from "es-toolkit";
import { ceil, floor, forEach, map, throttle, times } from "es-toolkit/compat";
import { nanoid } from "nanoid";
import * as PIXI from "pixi.js";
import { Bounds } from "protocol";
import {
  LayerParams,
  LayerShading,
  makeRenderer,
  SharedComponentStore,
  SourceHandle,
} from "renderer";
import type Flatbush from "flatbush";
import { D2RendererBase } from "../d2-renderer-base/D2RendererBase";
import { bodyBounds, cacheIndex, cachedIndex, openIndex, queryVisible } from "./columnarIndex";
import {
  D2BodyHit,
  D2RendererOptions,
  defaultD2RendererOptions,
  nextResolutionScale,
} from "./D2RendererOptions";
import { D2V2WorkerEvents, getTiles, tileCssSize } from "./D2RendererV2Worker";
import { D2RendererV2WorkerAdapter } from "./D2RendererV2WorkerAdapter";
import { hash } from "./hash";
import { TileUploadQueue } from "./TileUploadQueue";

function tileHash(bounds: Bounds) {
  return hash([bounds.top, bounds.right, bounds.bottom, bounds.left]);
}

/**
 * Bitmap tile sprite, positioned in world space.
 *
 * A tile **owns one `TextureSource` for its whole life** and re-uploads into it.
 * It does not mint a `Texture` per update, and that distinction is the difference
 * between a blit and a reallocation.
 *
 * PIXI caches a source's `GlTexture` on the source, and `glUploadImageResource`
 * only calls `texImage2D` — allocating fresh GPU storage — when the incoming size
 * differs from what that `GlTexture` already holds. Hand it the *same* source at
 * the *same* size and it takes its `texSubImage2D` branch instead, blitting into
 * storage that already exists. `Texture.from(bitmap)` cannot get there: PIXI can't
 * cache-key an `ImageBitmap`, so every call mints a new source with no `GlTexture`,
 * which means `gl.createTexture()` + a full `texImage2D` on upload and a
 * `gl.deleteTexture()` when the displaced one is destroyed. A scrub dirtying ~20
 * tiles at 24Hz was churning ~500 GPU texture allocations *per second* — the same
 * upload bandwidth as a blit, for a great deal of driver work and heap churn.
 *
 * A resize is still handled, and still correct: `TextureSource.update()` calls
 * `resize()`, which no-ops at an unchanged size but at a changed one bumps the
 * resource id and emits `resize` — which forces the one reallocation that a genuine
 * size change needs, and which `Texture` is itself listening for so it re-derives
 * its own extent. That is the dynamic-resolution ticker flipping tiles between full
 * and half size, and it is rare (twice a second, at worst) rather than per-frame.
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

  /**
   * The bitmap currently backing the texture.
   *
   * Held only so the one it displaces can be `close()`d. An `ImageBitmap` owns
   * off-heap pixels that GC reclaims lazily, and a scrub mints one per dirty tile
   * per frame — so leaving them to the collector means holding megabytes of decoded
   * bitmap that the GPU already has a copy of.
   */
  #bitmap: ImageBitmap;

  /** Stretch the bitmap over the tile's world extent. */
  #fit() {
    const { worldBounds: b, texture } = this;
    this.position.set(b.left, b.top);
    this.scale.set((b.right - b.left) / texture.width, (b.bottom - b.top) / texture.height);
  }

  #upload(bitmap: ImageBitmap, hash: string) {
    const prev = this.#bitmap;
    this.#bitmap = bitmap;
    this.texture.source.resource = bitmap;
    this.texture.source.update();
    // After `update()`, not before: a size change resizes the source, and the texture
    // only learns its new extent from the `resize` it fires.
    this.#fit();
    this.hash = hash;
    this.touch();
    // Safe to release the *displaced* bitmap, not the current one: PIXI uploads lazily,
    // at the next render, so `bitmap` has to outlive this call. `prev` does not — it has
    // either been uploaded already, or been superseded before it ever was.
    if (prev !== bitmap) prev.close();
  }

  reuse(bitmap: ImageBitmap, hash: string) {
    if (
      this.hash === hash &&
      this.texture.width * this.texture.height > bitmap.width * bitmap.height
    ) {
      // Keeping the higher-resolution bitmap we already have — but the worker
      // transferred this one to us, so it's ours to release.
      bitmap.close();
      return;
    }
    this.#upload(bitmap, hash);
  }

  override destroy() {
    super.destroy({ texture: true, textureSource: true });
    // After, not before: the source is what holds this bitmap, so let PIXI let go of it first.
    this.#bitmap.close();
  }

  constructor(
    bitmap: ImageBitmap,
    /** World-space extent. Not `bounds` — PIXI v8 defines that as a getter on
     * `ViewContainer`, and assigning over it throws. */
    public worldBounds: Bounds,
    public key: string,
    public hash: string = nanoid(),
  ) {
    // `skipCache`, deliberately. `Texture.from` otherwise registers the texture in the
    // global asset `Cache` keyed by the resource — and the key is an `ImageBitmap`, so
    // it can never be hit, only inserted into and (on destroy) removed from. This is
    // the one source this tile will ever have; nothing else may share it, because
    // `#upload` mutates it in place.
    super(PIXI.Texture.from(bitmap, true));
    this.label = key;
    this.#bitmap = bitmap;
    this.#fit();
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

/**
 * Ease a wheel tick's zoom over ~6 frames (see `zoomSmoothing`), rather than the
 * instant step the base class defaults to.
 *
 * Long enough to read as motion, short enough that a trackpad — whose two-finger
 * zoom arrives as a stream of small wheel events, so the camera trails the fingers
 * by the whole window — does not feel like it is dragging a weight.
 */
const defaultZoomSmoothing = 100;

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
  declare protected app?: PIXI.Application;
  protected options: D2RendererOptions = defaultD2RendererOptions;

  #tiles?: PIXI.Container<Tile>;
  /** Tiles by key. The container owns render order; this owns lookup — scanning
   * `#tiles.children` per update made tile bookkeeping quadratic. */
  #tileIndex = new Map<string, Tile>();
  #grid?: PIXI.Graphics;
  #workers: D2RendererV2WorkerAdapter[] = [];
  #step = 0;

  /**
   * The playhead, in memory the workers can read. Advancing it is one store rather
   * than a message to each worker — see {@link setStep}. Absent when the page is
   * not cross-origin isolated, in which case we fall back to messages.
   */
  #stepBuffer? = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
  #stepView? = this.#stepBuffer ? new Int32Array(this.#stepBuffer) : undefined;

  /** Tile bitmaps waiting for the GPU, bounded per frame. See {@link TileUploadQueue}. */
  #uploads = new TileUploadQueue<ImageBitmap>(tileHash);

  #layers = new Map<SourceHandle, Layer>();
  /** Handles whose index worker 0 is currently packing → the store it's for. */
  #pendingIndex = new Map<SourceHandle, SharedComponentStore>();

  protected override async setupPixi(o: D2RendererOptions) {
    await super.setupPixi(o);
    if (!this.viewport) return;
    this.#tiles = new PIXI.Container();
    this.#tiles.sortableChildren = true;
    this.viewport.addChild(this.#tiles);
    this.#grid = new PIXI.Graphics();
    this.viewport.addChild(this.#grid);
    this.#startDynamicResolution(o);
    this.viewport.on("mousemove", (e) => this.#queueHover(e));
    this.viewport.on("moved", () => this.#getUpdateGridQueue()());
    this.viewport.on("clicked", (e) => this.#click(e));
    // Ahead of PIXI's own render, which the Application adds at LOW priority — so a
    // tile drained this frame is on screen this frame.
    this.app!.ticker.add(this.#drainUploads, this, PIXI.UPDATE_PRIORITY.NORMAL);
  }

  /**
   * Hand this frame's share of the pending tiles to the GPU.
   *
   * Uploading a tile is not free — it points a texture at a new bitmap and PIXI
   * pushes it across on the next render — and a worker fleet under load can produce
   * a whole frustum's worth at once. Draining under a budget means the viewport
   * falls *behind* when it cannot keep up, instead of taking the UI down with it.
   */
  #drainUploads() {
    if (!this.#uploads.size) return;
    this.#uploads.drain(this.options.maxTileUploadsPerFrame, ({ bounds, hash, bitmap }) =>
      this.#addToWorld(bounds, hash, bitmap),
    );
  }

  /**
   * Report the bodies under the pointer as (layer, index) pairs.
   *
   * The base class also fires `click` here, but it resolves against `this.system`
   * — the rbush the v1 `add()` path fills, which v2 leaves empty — so that event
   * carries nothing. This queries the same shared Flatbush the renderer draws
   * from, so hit-testing needs no second index and no per-body objects.
   *
   * Topmost first, which means sorting by the *layer's* draw order before the body
   * index: indices are per-store, so comparing them across layers is meaningless —
   * body 5 of a layer underneath is not "above" body 3 of the layer on top. Within a
   * layer, bodies draw in ascending index order, so the highest index is on top. (A
   * graph packs edges before nodes precisely so that clicking where a node overlaps
   * its own edge selects the node.)
   */
  #click(e: { world: PIXI.Point; event: Event }) {
    const { x, y } = e.world;
    const point = { left: x, top: y, right: x + Number.MIN_VALUE, bottom: y + Number.MIN_VALUE };
    const bodies: (D2BodyHit & { z: number })[] = [];
    for (const [handle, layer] of this.#layers) {
      if (!layer.fb) continue;
      const z = layer.params.index ?? 0;
      for (const i of queryVisible(layer.store, layer.fb, point, this.#step, { sort: false })) {
        bodies.push({ handle, index: i, z });
      }
    }
    bodies.sort((a, b) => b.z - a.z || b.index - a.index);
    // Unwrap PIXI's synthetic event to the DOM one it was made from. A
    // `FederatedPointerEvent` is not a `MouseEvent`, so a consumer that tests
    // `instanceof MouseEvent` before reading `clientX`/`clientY` — which is how you
    // place a context menu at the cursor — sees neither, and anchors to (0, 0).
    const native = (e.event as { nativeEvent?: Event }).nativeEvent ?? e.event;
    this.emit("clickBody", native, {
      world: { x, y },
      bodies: bodies.map(({ handle, index }) => ({ handle, index })),
    });
  }

  override async setup(options: Partial<D2RendererOptions>) {
    // Ahead of `options`, not after it: this is a default v2 chooses for itself, and a
    // caller that passes `zoomSmoothing` still wins.
    await super.setup({ zoomSmoothing: defaultZoomSmoothing, ...options });
    this.#handleWorkerChange(this.options);
  }

  destroy(): void {
    map(this.#workers, (w) => w.terminate());
    if (this.#hoverFrame !== undefined) cancelAnimationFrame(this.#hoverFrame);
    // Before the tiles: these are bitmaps that never made it onto one, and they own
    // off-heap pixels the collector would otherwise sit on.
    this.#uploads.clear();
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
    } else {
      // Cached index: drawable already. Announce it anyway (asynchronously, so a
      // listener registered right after `load()` still hears it), or a remount
      // against a cached store would wait forever for a fit that never comes.
      queueMicrotask(() => this.emit("layerIndexed", id));
    }
    this.#clearResolved();
    // Push the current frustum so freshly-loaded workers render the visible region
    // immediately instead of their default 256² frustum. The step needs no pushing
    // when it is shared — they already read it from memory.
    this.handleFrustumChange();
    if (!this.#stepView) this.#workers.forEach((w) => w.call("setStep", [this.#step]));
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
    // The layer only now has bounds. `fitCamera` before this point fits nothing.
    this.emit("layerIndexed", handle);
  }

  #clearResolved() {
    for (const t of this.#tileIndex.values()) t.resolved = false;
  }

  /**
   * Advance the playhead.
   *
   * When the workers share a step buffer this is a single store to memory: they
   * sample it themselves, on their own clock (see
   * {@link D2RendererV2Worker.setStepBuffer}). Playback therefore costs the main
   * thread *nothing* per step, and the renderer is free to skip the steps it was
   * too slow to draw — only the latest playhead is ever visible, so an intermediate
   * one is work nobody would have seen.
   *
   * Without `SharedArrayBuffer` (no cross-origin isolation) it falls back to what
   * it did before: a message per worker per step.
   */
  setStep(step: number): void {
    if (step === this.#step) return;
    this.#step = step;
    if (this.#stepView) {
      Atomics.store(this.#stepView, 0, step);
      return;
    }
    this.#workers.forEach((w) => w.call("setStep", [step]));
  }

  setLayerParams(handle: SourceHandle, params: LayerParams): void {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.params = { ...layer.params, ...params };
    this.#workers.forEach((w) => w.call("setLayerParams", [handle, params]));
  }

  /**
   * Recolour a layer, keeping its geometry and its Flatbush. See {@link LayerShading}.
   *
   * The columns are SharedArrayBuffer-backed, so this shares them with the workers
   * rather than copying: only the small `palette`/`ramps` arrays are cloned. The
   * main-thread copy is updated too, because hit-testing reads the same store.
   */
  setLayerShading(handle: SourceHandle, shading: LayerShading): void {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.store = { ...layer.store, ...shading };
    this.#workers.forEach((w) => w.call("setLayerShading", [handle, shading]));
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
      // After `setup`: the sampling interval is read from the options.
      if (this.#stepBuffer) worker.call("setStepBuffer", [this.#stepBuffer]);
      return worker;
    });
  }

  /**
   * Note this takes its options as an argument rather than reading `this.options`.
   *
   * `D2RendererBase.setup` calls `setupPixi(o)` *before* `setOptions(o)`, so at this
   * point `this.options` is still the class-field default — and reading the disable
   * flag from it would find `undefined` rather than `false`, silently starting the
   * ticker on a renderer that asked for it to be off.
   */
  #startDynamicResolution(o: D2RendererOptions) {
    const { dynamicResolution } = o;
    // Off: leave tiles pinned at `tileResolution`. Guarded here rather than by
    // setting minScale === maxScale, which would still post a setTileResolution to
    // every worker on every tick for the life of the renderer.
    if (dynamicResolution.enabled === false) return;
    const { intervalMs, minScale } = dynamicResolution;
    const targetFrames = floor(PIXI.Ticker.targetFPMS * intervalMs);
    let frames = 0;
    let cdt = 0;
    let scale = minScale;
    // PIXI v8 hands the ticker itself to the callback, where v7 passed the delta
    // directly. `deltaTime` is that same scaled-frame delta (~1 at the target rate),
    // so the feedback loop's thresholds still mean what they did.
    this.app!.ticker.add((ticker) => {
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
      cdt += ticker.deltaTime;
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

  /**
   * The frustum, plus the scale a worker needs to express a size in CSS pixels.
   *
   * A worker cannot derive one on its own: it rasterizes into a bitmap that is
   * *stretched* over the tile's world bounds (see `Tile.#update`), so its only native
   * unit is the tile pixel — and a tile pixel is not a fixed number of CSS pixels. How
   * many depends on the display's dpr, the pane's size and the subdivision, so
   * everything the draw path called a "pixel" meant something different on every
   * machine.
   *
   * The scale is a property of the *pane*, not of the camera — {@link tileCssSize}
   * takes no frustum, deliberately, and that is what keeps a zoom from re-rasterizing
   * every tile in the frustum. Sending it from here, on a callback that fires for the
   * camera, is a convenience: this is the message the worker already gets on both a
   * zoom and a resize, and only the latter can actually change the value.
   */
  protected override handleFrustumChange() {
    if (!this.viewport) return;
    const { top, bottom, left, right } = this.viewport;
    map(this.#workers, (w) =>
      w.call("setFrustum", [{ top, bottom, left, right }, tileCssSize(this.options)]),
    );
  }

  #handleUpdate({ bounds, bitmap, hash: nextHash }: D2V2WorkerEvents["update"]) {
    if (bitmap) {
      // Queued, not uploaded: the GPU work is metered out over frames, and a tile
      // re-rendered before we got to it supersedes its own predecessor.
      this.#uploads.push(bounds, nextHash, bitmap);
      return;
    }
    // A bitmap-less update means "unchanged — you already have this one". If a
    // newer bitmap for this tile is still queued, we are about to have something
    // strictly better, and re-requesting it would be a wasted round trip.
    if (this.#uploads.has(bounds)) return;
    this.#addToWorld(bounds, nextHash);
  }

  // Takes the raw bitmap, not a `Texture`: a tile mints its texture once, in its
  // constructor, and thereafter re-uploads into the source it already owns. See {@link Tile}.
  #addToWorld(bounds: Bounds, nextHash: string, bitmap?: ImageBitmap) {
    if (!this.viewport) return;
    const tileKey = tileHash(bounds);
    let tile = this.#tileIndex.get(tileKey);
    if (bitmap) {
      if (tile) tile.reuse(bitmap, nextHash);
      else {
        tile = new Tile(bitmap, bounds, tileKey, nextHash);
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
      dropped.push(oldest.worldBounds);
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
    forEach(this.#tiles?.children, (t) => (t.zIndex = 0));
    let numResolved = 0;
    let placeholders = 0;
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
      if (!t) {
        this.#grid?.rect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        placeholders++;
      }
    }
    // v8's Graphics is path-then-paint: queue every placeholder rect, then paint the
    // lot in one pass (`stroke` straight after `fill` re-uses the same path). Skipped
    // entirely when nothing is missing — the common case, and painting an empty path
    // would still dirty the geometry and force a rebuild every frame.
    if (placeholders) {
      this.#grid?.fill({ color: accentColor, alpha: 0.05 });
      this.#grid?.stroke({ width: 1 * px, color: accentColor, alpha: 0.5 });
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
    let hits = 0;
    for (const layer of this.#layers.values()) {
      if (!layer.fb) continue;
      // Unsorted: hit-testing doesn't care about draw order.
      for (const i of queryVisible(layer.store, layer.fb, point, this.#step, { sort: false })) {
        const [minX, minY, maxX, maxY] = bodyBounds(layer.store, i);
        this.overlay.rect(minX, minY, maxX - minX, maxY - minY);
        hits++;
      }
    }
    if (hits) this.overlay.stroke({ width: 2 * px, color: accentColor, alpha: 0.5 });
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
