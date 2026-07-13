import { clamp, isEqual, once } from "es-toolkit";
import { ceil, defer, find, floor, forEach, map, now, throttle, times } from "es-toolkit/compat";
import { nanoid, random } from "nanoid";
import { Viewport } from "pixi-viewport";
import * as PIXI from "pixi.js";
import { Bounds } from "protocol";
import { ComponentEntry, makeRenderer } from "renderer";
import { D2RendererBase } from "../d2-renderer-base/D2RendererBase";
import { Bush } from "./Bush";
import { CompiledD2IntrinsicComponent } from "./D2IntrinsicComponents";
import { D2RendererOptions, defaultD2RendererOptions } from "./D2RendererOptions";
import { D2WorkerEvent, getTiles } from "./D2RendererWorker";
import { D2RendererWorkerAdapter } from "./D2RendererWorkerAdapter";
import { hash } from "./hash";
import { primitives } from "./primitives";

function tileHash(bounds: Bounds) {
  return hash([bounds.top, bounds.right, bounds.bottom, bounds.left]);
}

class Tile extends PIXI.Sprite {
  static age: number = 0;
  age: number = Tile.age++;
  #update(texture: PIXI.Texture, hash: string, isError: boolean) {
    const bounds = {
      ...this.worldBounds,
      width: this.worldBounds.right - this.worldBounds.left,
      height: this.worldBounds.bottom - this.worldBounds.top,
    };
    const scale = {
      x: bounds.width / texture.width,
      y: bounds.height / texture.height,
    };
    this.isError = isError;
    this.texture = texture;
    this.position.set(this.worldBounds.left, this.worldBounds.top);
    this.scale.set(scale.x, scale.y);
    this.age = Tile.age++;
    this.hash = hash;
  }
  reuse(texture: PIXI.Texture, hash: string, isError: boolean) {
    // Return if hash did not change
    if (
      this.hash === hash &&
      this.texture.width * this.texture.height > texture.width * texture.height &&
      !isError &&
      !this.isError // if the texture is not an error, and the current texture is not an error
    )
      return;
    this.#update(texture, hash, isError);
  }
  constructor(
    texture: PIXI.Texture,
    /** World-space extent. Not `bounds` — PIXI v8 defines that as a getter on
     * `ViewContainer`, and assigning over it throws. */
    public worldBounds: Bounds,
    public key: string,
    public hash?: string,
    public isError: boolean = false,
  ) {
    super(texture);
    this.label = this.key;
    this.#update(texture, hash ?? nanoid(), isError);
  }
}

export class D2Renderer extends D2RendererBase {
  declare protected app?: PIXI.Application;
  protected options: D2RendererOptions = defaultD2RendererOptions;
  protected system: Bush<CompiledD2IntrinsicComponent> = new Bush(9);
  declare protected viewport?: Viewport;
  declare protected overlay?: PIXI.Graphics;

  #resolved: Record<string, boolean> = {};
  #tiles?: PIXI.Container<Tile>;
  #workers: D2RendererWorkerAdapter[] = [];
  #grid?: PIXI.Graphics;

  protected override async setupPixi(o: D2RendererOptions) {
    await super.setupPixi(o);
    if (!this.viewport) return;

    this.#tiles = new PIXI.Container();
    this.#tiles.sortableChildren = true;
    this.viewport.addChild(this.#tiles);

    this.#grid = new PIXI.Graphics();
    this.viewport.addChild(this.#grid);

    this.#startDynamicResolution();
  }
  override async setup(options: Partial<D2RendererOptions>) {
    await super.setup(options);
    this.#handleWorkerChange(this.options);
  }

  destroy(): void {
    map(this.#workers, (w) => w.terminate());
    super.destroy();
  }

  add(components: ComponentEntry<CompiledD2IntrinsicComponent>[]) {
    const id = nanoid();
    const idx = now();
    const remove = super.add(components);
    this.#workers?.forEach?.((w) => w.call("add", [components, id, idx]));
    this.#resolved = {};
    return () =>
      defer(() => {
        remove();
        this.#workers?.forEach?.((w) => w.call("remove", [id, idx]));
        this.#resolved = {};
      });
  }

  setOptions(o: D2RendererOptions) {
    super.setOptions(o);
    this.#updateGrid();
  }

  #getUpdateGridQueue = once(() =>
    throttle(() => this.#updateGrid(), this.options.refreshInterval),
  );
  #getUpdateOverlayQueue = once(() =>
    throttle((e: PIXI.FederatedPointerEvent) => this.#updateHover(e), this.options.refreshInterval),
  );

  protected override setupViewport(options: D2RendererOptions) {
    super.setupViewport(options);
    if (!this.viewport) return;

    this.viewport.on("moved", () => {
      this.#getUpdateGridQueue()();
    });

    this.viewport.on("mousemove", (e) => this.#getUpdateOverlayQueue()(e));
  }

  #startDynamicResolution() {
    const { dynamicResolution } = this.options;
    // Off: leave tiles pinned at `tileResolution`. v2 has always honoured this; v1 did
    // not, which made the flag a lie for anyone who switched the viewport to "Pixel
    // (legacy)" — the ticker kept flipping tile size underneath them. Guarded here
    // rather than by setting minScale === maxScale, which would still post a
    // setTileResolution to every worker on every tick for the life of the renderer.
    if (dynamicResolution.enabled === false) return;
    const { dtMax, dtMin, increment, intervalMs, maxScale, minScale } = dynamicResolution;
    const targetFrames = floor(PIXI.Ticker.targetFPMS * intervalMs);
    let frames = 0;
    let cdt = 0;
    let scale = 1;
    // v8 passes the ticker, not the delta; `deltaTime` is v7's `dt`.
    this.app!.ticker.add((ticker) => {
      const { tileResolution } = this.options;
      if (!(frames % targetFrames)) {
        const adt = cdt / targetFrames;
        scale = clamp(
          adt >= dtMax ? scale + increment : adt <= dtMin ? scale - increment : scale,
          minScale,
          maxScale,
        );
        map(this.#workers, (w) => {
          w.call("setTileResolution", [
            {
              width: ceil(tileResolution.width / scale),
              height: ceil(tileResolution.height / scale),
            },
          ]);
        });
        cdt = 0;
      }
      cdt += ticker.deltaTime;
      frames++;
    });
  }

  #handleWorkerChange(options: D2RendererOptions) {
    map(this.#workers, (w) => w.terminate());
    this.#workers = times(options.workerCount, (i) => {
      const worker = new D2RendererWorkerAdapter();
      worker.on("update", (e) => this.#handleUpdate(e));
      worker.onerror = (e) => {
        throw e;
      };
      worker.call("setup", [{ ...options, workerIndex: i }]);
      return worker;
    });
  }

  protected override handleWindowSizeChange(options: D2RendererOptions) {
    super.handleWindowSizeChange(options);
    map(this.#workers, (w) => {
      w.call("setTileResolution", [
        {
          width: ceil(options.tileResolution.width),
          height: ceil(options.tileResolution.height),
        },
      ]);
    });
  }

  #handleUpdate({ bounds, bitmap, hash: nextHash, isError }: D2WorkerEvent<"update">["payload"]) {
    const texture = bitmap ? PIXI.Texture.from(bitmap) : undefined;
    this.#addToWorld(bounds, nextHash, texture, isError);
  }

  protected override handleFrustumChange() {
    if (!this.viewport) return;
    const { top, bottom, left, right } = this.viewport;
    map(this.#workers, (w) => w.call("setFrustum", [{ top, bottom, left, right }]));
  }

  #updateGrid() {
    if (!this.viewport) return;
    const { tileSubdivision, accentColor } = this.options;
    const { tiles } = getTiles(this.viewport, tileSubdivision);
    const px = this.getPx();
    this.#grid?.clear();
    forEach(this.#tiles?.children, (t) => (t.zIndex = 0));
    let numResolved = 0;
    let placeholders = 0;
    for (const { bounds: b } of tiles) {
      const key = tileHash(b);
      const t = find(this.#tiles?.children, (c) => c.key === key);
      const resolved = this.#resolved[key];
      if (t && resolved) {
        t.zIndex = 1;
        t.visible = true;
        numResolved++;
      }
      if (!t) {
        this.#grid?.rect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        placeholders++;
      }
    }
    // v8's Graphics is path-then-paint: queue the placeholder rects, paint once.
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

  #updateHover(e: PIXI.FederatedPointerEvent) {
    const { accentColor } = this.options;
    const px = this.getPx();
    const { x, y } = this.viewport!.toWorld(e.globalX, e.globalY);
    const bodies = this.system
      .search({
        minX: x,
        minY: y,
        maxX: x + Number.MIN_VALUE,
        maxY: y + Number.MIN_VALUE,
      })
      .filter((c) => primitives[c.component.$].narrow(c.component, { x, y }));
    this.overlay!.clear();
    // Stroked one rect at a time, not batched: the alpha is per body.
    for (const b of bodies) {
      this.overlay!.rect(b.left, b.top, b.right - b.left, b.bottom - b.top).stroke({
        width: 2 * px,
        color: accentColor,
        alpha: "$info" in b.component ? 1 : 0.02,
      });
    }
  }

  async #addToWorld(
    bounds: Bounds,
    nextHash: string,
    texture?: PIXI.Texture,
    isError: boolean = false,
  ) {
    if (!this.viewport) return;

    const tileKey = tileHash(bounds);
    const existing = find(this.#tiles?.children, (c) => c.key === tileKey);
    if (texture) {
      if (existing) {
        existing.reuse(texture, nextHash, isError);
      } else {
        const tile = new Tile(texture, bounds, tileKey, nextHash, isError);
        this.#tiles!.addChild(tile);
      }
    }
    this.#resolved[tileKey] = true;
    this.#updateGrid();
  }
}

export default makeRenderer(D2Renderer, {
  components: ["rect", "circle", "path", "polygon"],
  id: "d2-renderer-legacy",
  name: "Pixel (legacy)",
  description: "Previous-generation 2D renderer; clones components to each worker",
  version: "1.0.0",
});

// change options like color and schema
// query for a chunk
// add remove elements
