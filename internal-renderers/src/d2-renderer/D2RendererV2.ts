import { clamp } from "es-toolkit";
import { ceil, find, floor, forEach, map, times } from "es-toolkit/compat";
import { nanoid } from "nanoid";
import * as PIXI from "pixi.js";
import { Bounds } from "protocol";
import {
  LayerParams,
  makeRenderer,
  SharedComponentStore,
  SourceHandle,
} from "renderer";
import type Flatbush from "flatbush";
import { D2RendererBase } from "../d2-renderer-base/D2RendererBase";
import { bodyBounds, buildIndexedGeneration, openIndex, queryVisible } from "./columnarIndex";
import { D2RendererOptions, defaultD2RendererOptions } from "./D2RendererOptions";
import { D2V2WorkerEvents, getTiles } from "./D2RendererV2Worker";
import { D2RendererV2WorkerAdapter } from "./D2RendererV2WorkerAdapter";
import { hash } from "./hash";

function tileHash(bounds: Bounds) {
  return hash([bounds.top, bounds.right, bounds.bottom, bounds.left]);
}

/** Bitmap tile sprite, positioned in world space. (Same shape as v1's Tile.) */
class Tile extends PIXI.Sprite {
  static age: number = 0;
  age: number = Tile.age++;
  #update(texture: PIXI.Texture, hash: string) {
    const scale = {
      x: (this.bounds.right - this.bounds.left) / texture.width,
      y: (this.bounds.bottom - this.bounds.top) / texture.height,
    };
    this.texture = texture;
    this.setTransform(this.bounds.left, this.bounds.top, scale.x, scale.y);
    this.age = Tile.age++;
    this.hash = hash;
  }
  reuse(texture: PIXI.Texture, hash: string) {
    if (this.hash === hash && this.texture.width * this.texture.height > texture.width * texture.height)
      return;
    this.#update(texture, hash);
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

type Layer = { store: SharedComponentStore; index?: SharedArrayBuffer; params?: LayerParams };

/**
 * Main-thread half of the v2 renderer. Owns the PIXI viewport + tile sprites and
 * a fleet of v2 workers. Instead of fanning cloned components (v1 `add`), it
 * `load()`s an immutable {@link SharedComponentStore}: the shared Flatbush is
 * built once and handed to every worker (SAB, no clone), and the playhead drives
 * visibility via `setStep`. Hover/click query the same shared index — there is
 * no per-renderer rbush copy.
 */
export class D2RendererV2 extends D2RendererBase {
  protected declare app?: PIXI.Application<HTMLCanvasElement>;
  protected options: D2RendererOptions = defaultD2RendererOptions;

  #resolved: Record<string, boolean> = {};
  #tiles?: PIXI.Container<Tile>;
  #grid?: PIXI.Graphics;
  #workers: D2RendererV2WorkerAdapter[] = [];
  #step = 0;

  // First slice: a single trace layer. (P7 generalises to a per-layer list.)
  #layers = new Map<SourceHandle, Layer>();
  #main?: { store: SharedComponentStore; fb: Flatbush };

  protected override setupPixi(o: D2RendererOptions) {
    super.setupPixi(o);
    if (!this.viewport) return;
    this.#tiles = new PIXI.Container();
    this.#tiles.sortableChildren = true;
    this.viewport.addChild(this.#tiles);
    this.#grid = new PIXI.Graphics();
    this.viewport.addChild(this.#grid);
    this.#startDynamicResolution();
    this.viewport.on("mousemove", (e) => this.#updateHover(e));
  }

  setup(options: Partial<D2RendererOptions>) {
    super.setup(options);
    this.#handleWorkerChange(this.options);
  }

  destroy(): void {
    map(this.#workers, (w) => w.terminate());
    super.destroy();
  }

  // v2 uses load(); add() is intentionally inert so a stray legacy call is a
  // no-op rather than silently populating the (unused) main-thread rbush.
  override add() {
    return () => {};
  }

  load(store: SharedComponentStore, params?: LayerParams): SourceHandle {
    const id = nanoid();
    const { index } = buildIndexedGeneration(store);
    this.#layers.set(id, { store, index, params });
    this.#main = index ? { store, fb: openIndex(index) } : undefined;
    this.#workers.forEach((w) => w.call("setGeneration", [{ store, index, generation: store.generation }]));
    this.#resolved = {};
    // Push the current frustum + step so freshly-loaded workers render the
    // visible region immediately instead of their default 256² frustum.
    this.handleFrustumChange();
    this.#workers.forEach((w) => w.call("setStep", [this.#step]));
    return id;
  }

  unload(handle: SourceHandle): void {
    this.#layers.delete(handle);
    this.#main = undefined;
    this.#workers.forEach((w) => w.call("setGeneration", [undefined]));
    this.#resolved = {};
  }

  setStep(step: number): void {
    if (step === this.#step) return;
    this.#step = step;
    this.#workers.forEach((w) => w.call("setStep", [step]));
  }

  setLayerParams(handle: SourceHandle, params: LayerParams): void {
    const layer = this.#layers.get(handle);
    if (layer) layer.params = { ...layer.params, ...params };
    // Compositing application is P7; membership/visibility are unaffected.
  }

  #handleWorkerChange(options: D2RendererOptions) {
    map(this.#workers, (w) => w.terminate());
    this.#workers = times(options.workerCount, (i) => {
      const worker = new D2RendererV2WorkerAdapter();
      worker.on("update", (e) => this.#handleUpdate(e));
      worker.onerror = (e) => {
        throw e;
      };
      worker.call("setup", [{ ...options, workerIndex: i }]);
      return worker;
    });
  }

  #startDynamicResolution() {
    const { dynamicResolution } = this.options;
    const { dtMax, dtMin, increment, intervalMs, maxScale, minScale } = dynamicResolution;
    const targetFrames = floor(PIXI.Ticker.targetFPMS * intervalMs);
    let frames = 0;
    let cdt = 0;
    let scale = 1;
    this.app!.ticker.add((dt) => {
      const { tileResolution } = this.options;
      if (!(frames % targetFrames)) {
        const adt = cdt / targetFrames;
        scale = clamp(adt >= dtMax ? scale + increment : adt <= dtMin ? scale - increment : scale, minScale, maxScale);
        map(this.#workers, (w) =>
          w.call("setTileResolution", [
            { width: ceil(tileResolution.width / scale), height: ceil(tileResolution.height / scale) },
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
    const existing = find(this.#tiles?.children, (c) => c.key === tileKey);
    if (texture) {
      if (existing) existing.reuse(texture, nextHash);
      else this.#tiles!.addChild(new Tile(texture, bounds, tileKey, nextHash));
    }
    this.#resolved[tileKey] = true;
    this.#updateGrid();
  }

  #updateGrid() {
    if (!this.viewport) return;
    const { tileSubdivision, accentColor } = this.options;
    const { tiles } = getTiles(this.viewport, tileSubdivision);
    const px = this.getPx();
    this.#grid?.clear();
    this.#grid?.lineStyle(1 * px, accentColor, 0.5);
    this.#grid?.beginFill(accentColor, 0.05);
    forEach(this.#tiles?.children, (t) => (t.zIndex = 0));
    let numResolved = 0;
    for (const { bounds: b } of tiles) {
      const key = tileHash(b);
      const t = find(this.#tiles?.children, (c) => c.key === key);
      if (t && this.#resolved[key]) {
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

  #updateHover(e: PIXI.FederatedPointerEvent) {
    if (!this.#main || !this.viewport || !this.overlay) return;
    const { accentColor } = this.options;
    const px = this.getPx();
    const { x, y } = this.viewport.toWorld(e.globalX, e.globalY);
    const hits = queryVisible(
      this.#main.store,
      this.#main.fb,
      { left: x, top: y, right: x + Number.MIN_VALUE, bottom: y + Number.MIN_VALUE },
      this.#step,
    );
    this.overlay.clear();
    for (const i of hits) {
      const [minX, minY, maxX, maxY] = bodyBounds(this.#main.store, i);
      this.overlay.lineStyle(2 * px, accentColor, 0.5);
      this.overlay.drawRect(minX, minY, maxX - minX, maxY - minY);
    }
  }
}

export default makeRenderer(D2RendererV2, {
  components: ["rect", "circle"],
  id: "d2-renderer-v2",
  name: "Pixel (beta)",
  description: "Shared-memory 2D renderer (beta)",
  version: "0.1.0",
  supportsLoad: true,
});
