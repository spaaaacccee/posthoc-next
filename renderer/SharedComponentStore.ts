/** Discriminator values, indexed by the `kind` column of a store. */
export const COMPONENT_KINDS = ["rect", "circle", "path", "polygon", "text"] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * Columnar, `SharedArrayBuffer`-backed representation of one layer's draw
 * primitives. Built once per *generation* (off the main thread) and read
 * zero-copy by every render worker — no per-worker object inflation and no
 * structured-clone fan-out.
 *
 * Every typed array here is backed by a `SharedArrayBuffer`, so passing a store
 * over `postMessage` shares the memory rather than copying it. `palette` (plain
 * strings) is small and is structured-cloned.
 *
 * Visibility is decoupled from membership. Every body carries a *contiguous*
 * lifespan `[start, end)` in step space; a body is visible at step `s` iff
 * `start[i] <= s && s < end[i]`. Persistent bodies use `end === total`,
 * own-transient use `[step, step + 1)`, and specials use `[emit, clear)`.
 *
 * This object is the app→renderer boundary payload: it is renderer-agnostic
 * (carries no bounding boxes and no spatial index — those are the renderer's to
 * derive from these columns).
 */
export type SharedComponentStore = {
  /** Monotonic id, bumped on every rebuild so readers can latch a generation. */
  generation: number;
  /** Number of bodies. */
  count: number;
  /** Total step count of the source trace (upper bound for open-ended spans). */
  total: number;

  /** Per-body kind: an index into {@link COMPONENT_KINDS}. */
  kind: Uint8Array;

  /** Anchor: rect top-left / circle centre / first vertex for path & polygon. */
  x: Float32Array;
  y: Float32Array;
  /** Primary size: rect width / circle radius / path line width. */
  size: Float32Array;
  /** Secondary size: rect height (0 for other kinds). */
  size2: Float32Array;
  /** Opacity in [0, 1]. */
  alpha: Float32Array;

  /** Visibility span, half-open, in step space. */
  start: Int32Array;
  end: Int32Array;

  /** Fill colour: an index into {@link SharedComponentStore.palette}. */
  fill: Int32Array;
  /** Deduped CSS colour strings; `fill[i]` indexes this. Empty entry 0 = none. */
  palette: string[];

  /** Text label: an index into {@link SharedComponentStore.strings} (0 = none). */
  label: Int32Array;
  /** Deduped label strings for `text` bodies; `label[i]` indexes this. */
  strings: string[];

  /**
   * Ragged points for path/polygon. Body `i`'s points occupy
   * `pts[ptOff[i] * 2 .. ptOff[i + 1] * 2)` as interleaved x,y. `ptOff` has
   * length `count + 1`; rect/circle contribute no points
   * (`ptOff[i] === ptOff[i + 1]`).
   */
  ptOff: Int32Array;
  pts: Float32Array;
};

/** Opaque handle returned by `Renderer.load`, used to update or unload a layer. */
export type SourceHandle = string;

/** Per-layer compositing parameters; all free to change without a rebuild. */
export type LayerParams = {
  /** Compositing order; higher draws later (mirrors `meta.sourceLayerIndex`). */
  index?: number;
  /** Layer opacity multiplier in [0, 1]. */
  alpha?: number;
  /** Canvas compositing mode. */
  displayMode?: GlobalCompositeOperation;
  /** Owning layer's key (mirrors `meta.sourceLayer`); used by fitCamera. */
  sourceLayer?: string;
};
