import { isEqual } from "es-toolkit";
import { once, throttle } from "es-toolkit/compat";
import type { Bounds, Point, Size } from "protocol";
import type { LayerParams, LayerShading, SharedComponentStore } from "renderer";
import { shadeOf } from "renderer";
import type Flatbush from "flatbush";
import type { DrawOptions } from "./columnarDraw";
import { buildLabelGrid, columnarDrawTransform, drawBody, screenPad } from "./columnarDraw";
import { isStepInvariant, openIndex, packIndex, QueryScratch, queryVisible } from "./columnarIndex";
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
  /** A layer's spatial index, packed here so the main thread never stalls on it. */
  index: {
    handle: string;
    generation: number;
    index?: SharedArrayBuffer;
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

/** A step-invariant layer's rasterized contribution to one tile. */
type LayerTile = {
  hash: number;
  /** Absent when the layer has no bodies in this tile — cache the *miss* too. */
  canvas?: OffscreenCanvas;
  width: number;
  height: number;
};

type OpenLayer = Generation & {
  fb?: Flatbush;
  colors: Map<number, string>;
  params: LayerParams;
  /** Per-layer, because `#renderTile` holds every layer's query result at once. */
  scratch: QueryScratch;
  /** Every body visible at every step → this layer's tiles never change. */
  invariant: boolean;
  /** Cached rasters, populated only when `invariant`. */
  tiles: Map<string, LayerTile>;
};

const MAX_TILE_CACHE = 512;

/**
 * The CSS size one tile covers on screen, at the tile grid's *nominal* density — the
 * scale every screen-space size in the draw path resolves through.
 *
 * **It takes no frustum, and that is the point.** `getTiles` cuts the frustum's longer
 * side into a power-of-two world size, so the number of tiles across it slides from
 * 2^subdivision to 2^(subdivision+1) through an octave of zoom and snaps back at the
 * boundary. A scale read off the *live* camera would therefore change continuously as
 * you zoom — and since it feeds the tile's pixels, it is part of the tile's content
 * hash, so every tile in the frustum would re-rasterize and re-transmit for the whole
 * gesture. That is a zoom that visibly churns.
 *
 * Anchoring to the grid's middle density (the geometric mean of that range) instead
 * makes a zoom *within* an octave free, as it was before any of this: tile bounds are
 * world-anchored, the tiles are already right, and the GPU just scales the sprites.
 * The price is that a body sized in CSS pixels breathes by up to a factor of sqrt(2)
 * either way across an octave — the tile grid's real density doing what it does.
 */
export const tileCssSize = ({ screenSize, tileSubdivision }: D2RendererOptions) =>
  Math.max(screenSize.width, screenSize.height) / 2 ** (tileSubdivision + 0.5);

/** A tile's identity: its bounds. Its *size* in pixels is a property of the
 * raster, not of the tile, so it belongs in the cached value — where the
 * "already have it at this size or better" check below reads it. */
const tileKey = ({ top, right, bottom, left }: Bounds) => hash([top, right, bottom, left]);

/**
 * Cached rasters per step-invariant layer, per worker. A deliberate
 * memory-for-time trade: at dpr 2 a tile is 512², so an entry is ~1MB. What it
 * buys is taking the map layer out of the scrub hot path entirely — otherwise its
 * walls are re-rasterized into every tile on every step, only because the trace
 * layer above them changed.
 *
 * A worker only renders its own stride of tiles (see `#shouldRender`), so it only
 * caches those — the bound needn't cover the whole frustum. It does need slack for
 * both tile sizes, since size is part of the key: dynamic resolution is binary
 * (full or half), so a tile can be held at two.
 */
const MAX_LAYER_TILES = 96;

/**
 * Only cache a layer's raster for a tile once it holds at least this many bodies.
 *
 * Compositing from the cache costs one `drawImage` — a full-tile blit, ~262k
 * pixels at 512². Rasterizing a handful of rects costs far less, so for a *sparse*
 * invariant layer (a maze map with a few dozen walls in view) the cache would be a
 * pessimisation: cheap draws traded for an expensive blit, plus a megabyte of
 * canvas. Past this many bodies the rasterization dominates and the blit is the
 * cheaper half.
 *
 * Empty tiles are still cached, as a canvas-less entry: that costs no memory and
 * still saves the query.
 */
const MIN_BODIES_TO_CACHE = 256;

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
  #ordered?: OpenLayer[];

  // Pooled rasterization surfaces, reallocated only when the tile size changes.
  // `transferToImageBitmap` resets a canvas to transparent black but leaves it
  // usable, so a worker needs exactly two for the life of the process.
  #out?: OffscreenCanvas;
  #outCtx?: OffscreenCanvasRenderingContext2D;
  #scratch?: OffscreenCanvas;
  #scratchCtx?: OffscreenCanvasRenderingContext2D;

  setup(options: D2RendererOptions) {
    this.#options = options;
    this.#invalidate();
  }

  /**
   * The CSS size one tile covers on screen. From {@link tileCssSize}, via the main
   * thread — a worker has no camera and no pane to derive it from.
   *
   * `tile.width / #tileCssSize` is then the tile pixels in one CSS pixel: the factor
   * that turns every screen-space quantity in {@link DrawOptions} — size clamps, label
   * font, arrowheads, the splat threshold — into the tile's own units.
   */
  #tileCssSize = 1;

  setFrustum(frustum: Bounds, tileCssSize = 1) {
    this.#frustum = frustum;
    this.#tileCssSize = tileCssSize > 0 ? tileCssSize : 1;
    this.#getRenderQueue()();
  }

  setTileResolution(tileResolution: Size) {
    // Guard on change: the dynamic-resolution ticker calls this every interval,
    // and an unconditional cache clear + invalidate would re-rasterize every
    // tile on every tick.
    if (isEqual(tileResolution, this.#options.tileResolution)) return;
    this.#options = { ...this.#options, tileResolution };
    this.#cache.clear();
    // Deliberately NOT clearing the layers' raster caches. The dynamic-resolution
    // ticker flips the tile size every 500ms under load (scale oscillates between
    // minScale and maxScale), so clearing here would re-rasterize every invariant
    // layer into a fresh canvas twice a second — worse than having no cache at
    // all. The rasters are keyed by size as well as position instead, so the
    // handful of distinct sizes coexist and the LRU bounds them.
    this.#invalidate();
  }

  setStep(step: number) {
    if (step === this.#step) return;
    this.#step = step;
    // Deliberately no `#now++`. `#now` rotates the tile → worker assignment, and
    // rotating it here would hand every tile to a different worker on every
    // step — so the content-hash cache below, whose whole purpose is "same
    // content at a new step → don't re-rasterize", would be consulted by a
    // worker that never rendered that tile. Ownership stays fixed across a
    // scrub; it only rebalances when the layer set changes (which clears the
    // cache anyway, so nothing is lost).
    this.#invalidate();
  }

  /** Add or replace a layer's generation. */
  setLayer(handle: string, gen: Generation, params: LayerParams = {}) {
    this.#layers.set(handle, {
      ...gen,
      fb: gen.index ? openIndex(gen.index) : undefined,
      colors: new Map(),
      params,
      scratch: new QueryScratch(),
      invariant: isStepInvariant(gen.store),
      tiles: new Map(),
    });
    this.#dirty();
    this.#now++;
    this.#invalidate();
  }

  /**
   * Attach a layer's index once it has been packed (see {@link buildLayerIndex}).
   * Until then the layer has no `fb` and contributes nothing to a tile.
   */
  setLayerIndex(handle: string, index?: SharedArrayBuffer) {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.index = index;
    layer.fb = index ? openIndex(index) : undefined;
    layer.tiles.clear(); // what's visible in each tile just changed
    this.#dirty();
    this.#invalidate();
  }

  /**
   * Pack this layer's spatial index and hand it back. O(n log n) over the whole
   * store — this is the job the main thread used to do inline in `load()`, and
   * the reason it stalled proportionally to trace size.
   */
  buildLayerIndex(handle: string) {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    const index = packIndex(layer.store);
    this.setLayerIndex(handle, index);
    this.emit(
      "message",
      { action: "index", payload: { handle, generation: layer.generation, index } },
      [],
    );
  }

  /**
   * Recolour a layer without touching its geometry — and, critically, without
   * touching `fb`. The spatial index is derived from position and size alone, so a
   * body that changes colour is still in the same box, and rebuilding the index
   * would be pure waste.
   *
   * This is what a highlight or a colour-by-property is: on a 717k-body graph it
   * swaps ~3MB of columns instead of repacking 40MB and rebuilding the R-tree.
   *
   * The raster cache does have to go: these are the pixels. `invariant` is
   * recomputed too, since a recolour can add or remove ramps and so change whether
   * the layer is step-invariant at all.
   */
  setLayerShading(handle: string, shading: LayerShading) {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    layer.store = { ...layer.store, ...shading };
    layer.colors.clear();
    layer.tiles.clear();
    layer.invariant = isStepInvariant(layer.store);
    this.#dirty();
    this.#invalidate();
  }

  removeLayer(handle: string) {
    if (this.#layers.delete(handle)) {
      this.#dirty();
      this.#now++;
      this.#invalidate();
    }
  }

  /**
   * Forget these tiles, and render them again.
   *
   * `#cache` is not a record of what this worker rasterized — it is a record of
   * *what the main thread already has*, which is the whole reason a hit ships a
   * hash and no bitmap. The main thread evicts tiles (see `TILE_BUDGET`), so that
   * belief goes stale, and a stale belief here is permanent: the tile is missing
   * on screen, every subsequent render agrees its content is unchanged, and so
   * none of them ever sends it. That is a placeholder that survives any amount of
   * panning and only heals when the playhead moves — a scrub is the one thing
   * that changes the content hash.
   *
   * It re-renders rather than merely forgetting because a tile the main thread has
   * dropped is one it needs *now*: the eviction is acknowledged after the pan that
   * caused it, so waiting for the next camera move would leave the hole on screen.
   */
  dropTiles(bounds: Bounds[]) {
    let dropped = false;
    for (const b of bounds) dropped = this.#cache.delete(tileKey(b)) || dropped;
    // Broadcast, so most workers own none of these — only the owner re-renders.
    if (dropped) this.#invalidate();
  }

  /**
   * Update a layer's compositing params — no rebuild, no repack of the store.
   *
   * Order, alpha and blend mode are applied when the layer is *composited* onto
   * the tile, so its own raster survives them: dragging an opacity slider
   * re-composites from `layer.tiles`. `sizing` and `label` are different — they
   * change the pixels the layer rasterizes to — so they have to drop that cache,
   * or a node-size slider would move nothing on an invariant layer.
   *
   * Both are still cheap relative to the alternative, which is why these knobs
   * live here and not in the store: a size or label change re-rasterizes, but it
   * never repacks columns or rebuilds the spatial index.
   */
  setLayerParams(handle: string, params: LayerParams) {
    const layer = this.#layers.get(handle);
    if (!layer) return;
    const raster =
      ("sizing" in params && !isEqual(params.sizing, layer.params.sizing)) ||
      ("label" in params && !isEqual(params.label, layer.params.label));
    layer.params = { ...layer.params, ...params };
    if (raster) layer.tiles.clear();
    this.#dirty();
    this.#invalidate();
  }

  /** Layer set or ordering changed: drop the memoized order and the tile cache. */
  #dirty() {
    this.#ordered = undefined;
    this.#cache.clear();
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

  /** Layers with a built index, in draw order (higher `index` on top). Memoized:
   * this used to allocate + sort once per tile. */
  #orderedLayers() {
    this.#ordered ??= [...this.#layers.values()]
      .filter((l) => l.fb)
      .sort((a, b) => (a.params.index ?? 0) - (b.params.index ?? 0));
    return this.#ordered;
  }

  /** The pooled output + scratch surfaces, sized to `tile`. */
  #surfaces(tile: Size) {
    if (this.#out?.width !== tile.width || this.#out?.height !== tile.height) {
      this.#out = new OffscreenCanvas(tile.width, tile.height);
      this.#outCtx = this.#out.getContext("2d", { alpha: false })!;
      this.#outCtx.imageSmoothingEnabled = false;
      this.#scratch = new OffscreenCanvas(tile.width, tile.height);
      this.#scratchCtx = this.#scratch.getContext("2d")!;
      this.#scratchCtx.imageSmoothingEnabled = false;
    }
    return {
      out: this.#out!,
      ctx: this.#outCtx!,
      scratch: this.#scratch!,
      scratchCtx: this.#scratchCtx!,
    };
  }

  /**
   * The frustum's tiles. Memoized on the frustum: `getTiles` allocates and
   * shuffles a fresh array, and a scrub re-renders at 24Hz without the camera
   * moving at all.
   */
  #frustumTiles() {
    const { tileSubdivision } = this.#options;
    const f = this.#frustum;
    const key = `${f.left},${f.top},${f.right},${f.bottom},${tileSubdivision}`;
    if (this.#tiles?.key !== key) {
      this.#tiles = { key, tiles: getTiles(f, tileSubdivision).tiles };
    }
    return this.#tiles.tiles;
  }
  #tiles?: { key: string; tiles: ReturnType<typeof getTiles>["tiles"] };

  render() {
    // Note: no layer guard. Empty tiles still paint the background + centre
    // notch, which is the only cue that panning is doing anything when nothing
    // is loaded (or you've panned off the content).
    for (const { tile, bounds } of this.#frustumTiles()) {
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
    const key = tileKey(bounds);

    // Hoisted above the query: a screen-space or pixel-clamped body's *world*
    // footprint depends on the zoom, so the query has to know the scale before it
    // can decide how far past the tile to look. See `screenPad`.
    const t = columnarDrawTransform(bounds, tile);

    // Tile pixels per CSS pixel: this tile's bitmap over the CSS size a tile nominally
    // covers. Everything the draw path calls a "pixel" is a CSS pixel, and this is what
    // makes that true. See {@link D2RendererV2Worker.#tileCssSize} for why it is
    // anchored to the tile grid rather than to the camera — in short, so that a zoom
    // does not invalidate every tile in the frustum.
    //
    // Reading the *actual* `tile.width` and not the configured resolution is what keeps
    // it honest under dynamic resolution: a half-size bitmap is stretched over the same
    // world bounds, so each of its pixels is twice as big on screen, and a 12px label
    // has to be drawn at 6 of them to still measure 12.
    const pixelScale = tile.width / this.#tileCssSize;

    // Per layer: either a cached raster (step-invariant layers only — a map's
    // pixels in this tile don't depend on the playhead) or the visible bodies to
    // draw, plus that layer's own content hash.
    //
    // Hashes are folded incrementally (FNV-1a): a tile can hold hundreds of
    // thousands of bodies, so neither spreading them into an array nor hashing
    // that array is viable — `push(...indices)` overflows the argument stack.
    // Keyed by size as well as position: the dynamic-resolution ticker flips the
    // tile size between a couple of discrete values, and both need to stay warm.
    // `pixelScale` is part of the key, not just the hash: an invariant layer's cached
    // raster is returned *without* recomputing its hash, so a pane resize — which moves
    // the scale without touching the bounds or the bitmap — would otherwise serve
    // pixels whose labels and clamps were drawn for a different pane.
    const layerKey = `${key}:${tile.width}x${tile.height}:${pixelScale.toFixed(3)}`;

    const perLayer = layers.map((l) => {
      const cached = l.invariant ? l.tiles.get(layerKey) : undefined;
      if (cached) {
        // Skips the spatial query, the span filter, the sort, the hash fold *and*
        // the rasterization — the whole layer, for the cost of one drawImage.
        return { l, cached, hash: cached.hash };
      }
      const opts: DrawOptions = {
        step: this.#step,
        sizing: l.params.sizing,
        label: l.params.label,
        pixelScale,
      };
      const pad = screenPad(l.store, t.sx, opts);
      const indices = queryVisible(
        l.store,
        l.fb!,
        { top: top - pad, left: left - pad, right: right + pad, bottom: bottom + pad },
        this.#step,
        { scratch: l.scratch },
      );
      let h = 0x811c9dc5;
      const mix = (v: number) => {
        h = Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0;
      };
      mix(l.generation);
      mix(indices.length);
      // The scale the tile's pixels were drawn at. Every screen-space size resolves
      // through it, so the same bodies at two scales are different content.
      mix(Math.round(pixelScale * 1024));
      if (l.store.ramps?.length) {
        // Fold each ramped body's *bucket*, not the raw step. That distinction is
        // the whole value of the ramp design: a tile whose ramped bodies have all
        // saturated hashes identically at step 5,000 and step 50,000, so it stays
        // cached — only tiles holding recently-touched bodies re-rasterize. Since
        // a search frontier is spatially local, a scrub repaints a handful of
        // tiles rather than every tile on screen (which is what sigma does).
        //
        // Mixing `this.#step` instead would be correct but would defeat the cache
        // entirely for the whole layer, on every step.
        for (const i of indices) {
          mix(i);
          mix(shadeOf(l.store, i, this.#step));
        }
      } else {
        for (const i of indices) mix(i);
      }
      // Cache the *miss* as well: an invariant layer with nothing in this tile
      // has nothing in it at any step, so there's no point re-querying it every
      // step just to find that out again. (Rasters for non-empty tiles are cached
      // in the draw loop below, where the canvas actually gets painted.)
      if (l.invariant && !indices.length) {
        this.#touchLayerTile(l, layerKey, {
          hash: h >>> 0,
          width: tile.width,
          height: tile.height,
        });
      }
      return { l, indices, opts, hash: h >>> 0 };
    });

    // Combine into the tile's hash. The separator keeps distinct layer splits
    // from colliding.
    let c = 0x811c9dc5;
    for (const { hash: lh } of perLayer) {
      c = Math.imul(c ^ 0xffffffff, 0x01000193) >>> 0;
      c = Math.imul(c ^ lh, 0x01000193) >>> 0;
    }
    const nextHash = c.toString(36);

    const prev = this.#cache.get(key);
    if (prev && prev.hash === nextHash && prev.width + prev.height >= tile.width + tile.height) {
      return { hash: prev.hash };
    }

    const { out: g, ctx, scratch: g2, scratchCtx: ctx2 } = this.#surfaces(tile);
    ctx.fillStyle = this.#options.backgroundColor;
    ctx.fillRect(0, 0, tile.width, tile.height);
    this.#drawNotch(ctx, tile);

    // Layers with nothing in this tile don't affect the composite, so they don't
    // count against the fast path below — an empty overlay shouldn't force the
    // one layer that *does* have content through a sub-canvas.
    const drawn = perLayer.filter((p) => (p.cached ? p.cached.canvas : p.indices!.length));
    for (const p of drawn) {
      const { l } = p;
      const alpha = l.params.alpha ?? 1;
      const mode = l.params.displayMode ?? "source-over";
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = mode;

      if (p.cached) {
        ctx.drawImage(p.cached.canvas!, 0, 0);
        continue;
      }
      const indices = p.indices!;
      const opts = p.opts!;
      // Decide which labels survive before drawing any of them — the grid is a
      // contest between bodies, so it can't be resolved one body at a time. Its
      // inputs (the indices, the transform, the label params) are all already in
      // the tile's hash, so it needs no cache key of its own.
      if (opts.label?.grid) {
        opts.labels = buildLabelGrid(l.store, indices, t, tile, opts.label, pixelScale);
      }

      if (l.invariant && indices.length >= MIN_BODIES_TO_CACHE) {
        // Dense enough that rasterizing costs more than a blit: draw once into a
        // canvas we keep, then composite from it. Every later step in this tile
        // takes the cached branch above. Below the threshold we fall through and
        // just draw — see MIN_BODIES_TO_CACHE.
        const own = new OffscreenCanvas(tile.width, tile.height);
        const ownCtx = own.getContext("2d")!;
        ownCtx.imageSmoothingEnabled = false;
        for (const i of indices) drawBody(l.store, i, ownCtx, t, l.colors, opts);
        this.#touchLayerTile(l, layerKey, {
          hash: p.hash,
          canvas: own,
          width: tile.width,
          height: tile.height,
        });
        ctx.drawImage(own, 0, 0);
        continue;
      }
      if (drawn.length === 1 && alpha === 1 && mode === "source-over") {
        // Sole layer, painted plainly: compositing it through a sub-canvas is a
        // no-op (source-over is associative), so draw straight onto the tile and
        // halve the fill rate.
        for (const i of indices) drawBody(l.store, i, ctx, t, l.colors, opts);
        continue;
      }
      // Otherwise the layer paints onto the shared sub-canvas, then composites
      // with its alpha + blend mode (matching v1's per-source-layer compositing).
      ctx2.clearRect(0, 0, tile.width, tile.height);
      for (const i of indices) drawBody(l.store, i, ctx2, t, l.colors, opts);
      ctx.drawImage(g2, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const bitmap = g.transferToImageBitmap();
    this.#touch(key, { hash: nextHash, width: bitmap.width, height: bitmap.height });
    return { hash: nextHash, bitmap };
  }

  /** Cache a step-invariant layer's raster for this tile, LRU-bounded. */
  #touchLayerTile(layer: OpenLayer, tileKey: string, value: LayerTile) {
    layer.tiles.delete(tileKey);
    layer.tiles.set(tileKey, value);
    if (layer.tiles.size > MAX_LAYER_TILES) {
      const oldest = layer.tiles.keys().next().value;
      if (oldest !== undefined) layer.tiles.delete(oldest);
    }
  }

  /** For tests: current tile-cache size. */
  get cacheSize() {
    return this.#cache.size;
  }

  /** For tests: cached rasters held across all step-invariant layers. */
  get layerTileCacheSize() {
    let n = 0;
    for (const l of this.#layers.values()) n += l.tiles.size;
    return n;
  }
}

export { getTiles };
