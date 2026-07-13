/** Discriminator values, indexed by the `kind` column of a store. */
export const COMPONENT_KINDS = ["rect", "circle", "path", "polygon", "text"] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * Arrowhead shapes, indexed by the nibbles of a store's `arrow` column.
 *
 * The full set is declared here — widening it later costs nothing, since these
 * are values in a `Uint8` column — but only `none` and `triangle` are drawn
 * today. Each additional shape is a branch in `drawBody` *and* a bbox-padding
 * case in `bodyBounds`; add one when something actually needs it.
 */
export const ARROW_SHAPES = ["none", "triangle", "arrow", "circle", "diamond", "bar"] as const;

export type ArrowShape = (typeof ARROW_SHAPES)[number];

/** Horizontal text anchoring, indexed by the low nibble of the `align` column. */
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** Vertical text anchoring, indexed by the high nibble of the `align` column. */
export const TEXT_BASELINES = ["alphabetic", "top", "middle", "bottom"] as const;
export type TextBaseline = (typeof TEXT_BASELINES)[number];

/** Pack two arrowhead shapes into one byte. Index 0 (`none`) is the default. */
export const packArrow = (start: number, end: number) => (start & 0xf) | ((end & 0xf) << 4);
export const arrowStart = (v: number) => v & 0xf;
export const arrowEnd = (v: number) => (v >> 4) & 0xf;

/** Pack alignment + baseline into one byte. Index 0/0 = `left`/`alphabetic`. */
export const packAlign = (align: number, baseline: number) =>
  (align & 0xf) | ((baseline & 0xf) << 4);
export const alignOf = (v: number) => v & 0xf;
export const baselineOf = (v: number) => (v >> 4) & 0xf;

/**
 * A colour that varies with the playhead: body `i` with `ramp[i] === r + 1`
 * resolves its fill from `ramps[r]` rather than from `fill[i]`.
 *
 * The ramp's colours are a *contiguous slice of the palette* — `palette[offset
 * .. offset + length)` — which is the point of the design: the resolved colour
 * is still just a palette index, so the draw path's colour cache (keyed on
 * palette index + alpha) works unchanged and a ramped body costs no more to
 * shade than a static one.
 *
 * The body's *age* is `step - start[i]`. It maps onto the ramp linearly over
 * `window` steps; beyond that the final colour holds indefinitely. This is what
 * expresses "recently visited nodes are hot, then fade to grey" without emitting
 * a body per colour per node.
 */
export type ColorRamp = {
  /** First palette index of this ramp's colours. */
  offset: number;
  /** Number of colours, i.e. buckets. */
  length: number;
  /** Steps over which the ramp is traversed. Past this, the last colour holds. */
  window: number;
};

/**
 * The palette index body `i` shades with at `step`, honouring its ramp.
 *
 * Shared by the draw path and the tile hasher, and it must stay that way: the
 * hasher folds this *bucket* rather than the raw step, which is what lets a tile
 * whose ramped bodies have all saturated keep a stable hash and stay cached. Two
 * implementations that disagree would serve stale pixels.
 */
export function shadeOf(store: SharedComponentStore, i: number, step: number): number {
  const r = store.ramp?.[i] ?? 0;
  if (!r) return store.fill[i]!;
  const ramp = store.ramps?.[r - 1];
  if (!ramp) return store.fill[i]!;
  const { offset, length, window } = ramp;
  const age = step - store.start[i]!;
  if (age <= 0) return offset;
  if (age >= window) return offset + length - 1;
  const bucket = Math.floor((age * length) / window);
  return offset + (bucket < length ? bucket : length - 1);
}

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
  /** Primary size: rect width / circle radius / path line width / text font size. */
  size: Float32Array;
  /**
   * Secondary size. Its meaning is per-kind: rect height; text's estimated pixel
   * width (bbox only); path's **arrowhead size, in screen pixels**. 0 elsewhere.
   */
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

  /**
   * Text label: an index into {@link SharedComponentStore.strings} (0 = none).
   *
   * On a `text` body this is the body's own content. On any *other* kind it is
   * an **inline label**, drawn by `drawBody` immediately after the primitive and
   * positioned relative to it — which is how a graph gets a million node labels
   * without a million extra bodies, and the only way a label can sit a fixed
   * number of pixels clear of a node whose screen radius varies with zoom.
   */
  label: Int32Array;
  /** Deduped label strings; `label[i]` indexes this. Empty entry 0 = none. */
  strings: string[];

  /**
   * Ragged points for path/polygon. Body `i`'s points occupy
   * `pts[ptOff[i] * 2 .. ptOff[i + 1] * 2)` as interleaved x,y. `ptOff` has
   * length `count + 1`; rect/circle contribute no points
   * (`ptOff[i] === ptOff[i + 1]`).
   */
  ptOff: Int32Array;
  pts: Float32Array;

  // ---- Optional columns. Absent means "no layer body uses this feature", which
  // is both the default and a cheap layer-wide skip in the draw path. A store
  // without any of them behaves exactly as it did before they existed.

  /**
   * Arrowheads on `path` bodies: two nibbles, `packArrow(start, end)`, indexing
   * {@link ARROW_SHAPES}. Sized by `size2` (screen pixels) and derived at draw
   * time from the terminal vertex and its incoming segment — *not* stored as
   * separate polygon bodies, which would double the edge count and need
   * regenerating on every zoom change.
   */
  arrow?: Uint8Array;

  /**
   * How far to back an arrowhead off its terminal vertex, so it lands on the edge of
   * the thing it points at rather than buried in the middle of it.
   *
   * The value is the **world size of the target body**, and the draw path resolves it
   * through the same sizing policy as `circle` — because in a graph an arrow points
   * at a node, and a node's drawn radius is a clamped, zoom-dependent screen quantity
   * (3-24px here). Storing a world-space inset instead cannot work: fitted, a 20-unit
   * radius is 0.08px while the node still draws at its 3px floor, so the head stays
   * under the circle. Storing a fixed screen inset cannot work either, since the
   * radius it must match changes with zoom.
   *
   * Absent, or 0 for a given body, means the head sits on the vertex.
   */
  arrowInset?: Float32Array;

  /**
   * Text anchoring: two nibbles, `packAlign(align, baseline)`, indexing
   * {@link TEXT_ALIGNS} / {@link TEXT_BASELINES}. Applies to `text` bodies and to
   * inline labels. 0 (`left`/`alphabetic`) reproduces the original behaviour.
   */
  align?: Uint8Array;

  /** Playhead-varying colour: `ramp[i] - 1` indexes `ramps`; 0 = static fill. */
  ramp?: Uint8Array;
  /** Ramp table. See {@link ColorRamp}. */
  ramps?: ColorRamp[];
};

/** Opaque handle returned by `Renderer.load`, used to update or unload a layer. */
export type SourceHandle = string;

/**
 * A layer's colour, swappable without touching its geometry.
 *
 * The columns here are exactly the ones that say what a body *looks like*; every
 * column that says where it *is* — `x`, `y`, `size`, `pts` — is absent. That split
 * is the point: the spatial index is derived from geometry alone, so a recolour
 * can reuse it verbatim rather than repacking it.
 *
 * It is what "highlight the path back to the root" and "colour nodes by their `g`
 * value" both really are. Doing either by rebuilding the store would cost a full
 * repack plus an O(n log n) index rebuild — ~450ms on a 717k-body graph — to
 * change two columns worth ~3MB. This is those two columns.
 */
export type LayerShading = Pick<
  SharedComponentStore,
  "fill" | "ramp" | "palette" | "ramps" | "generation"
>;

/**
 * How a kind's `size` column becomes a pixel size.
 *
 * A map is world-space: a wall is one world unit wide and should grow when you
 * zoom in. A *graph* is not — a node that keeps growing becomes a blob, and one
 * that keeps shrinking vanishes. So a graph layer wants world sizes clamped into
 * a pixel range, and wants its labels and arrowheads pinned to a fixed pixel size
 * outright.
 *
 * Both fall out of the same three knobs, and omitting all of them leaves the
 * original pure-world-space behaviour untouched.
 */
/**
 * Soften world-space growth across a zoom band — a *multiplier* on the size, not a
 * bound on it.
 *
 * Clamps are a blunt instrument: outside `[min, max]` a body is **pinned**, so it
 * stops responding to zoom entirely and a world-space layer starts feeling
 * screen-space. Damping never pins. It scales the size instead:
 *
 *  - zoomed out far enough (natural size <= `from`), multiply by `fromScale`. Above 1,
 *    so a body that world-space would render sub-pixel is lifted into view.
 *  - zoomed in far enough (natural size >= `to`), multiply by `toScale`. Below 1, so a
 *    body that world-space would render as a blob is held back.
 *  - in between, interpolate geometrically — growth is damped but never stops.
 *
 * "Natural size" is what pure world-space would give: `size * zoom`, in CSS pixels.
 * Stating the knees that way rather than as absolute zoom levels keeps the policy
 * independent of whatever units the layout happens to use.
 *
 * Two limits are worth knowing. `fromScale === toScale === 1` is pure world-space.
 * `fromScale / toScale === to / from` is exactly *constant screen size* across the
 * band — so the ratio between the scales is a dial from world-space to screen-space,
 * and anything in between is the "screen-space-ish" middle.
 */
export type SizeDamping = {
  /** Natural (undamped, world-space) CSS size at which damping begins. */
  from: number;
  /** Natural CSS size at which damping ends. */
  to: number;
  /** Multiplier at or below `from`. `>= 1` renders far-out bodies larger than world. */
  fromScale: number;
  /** Multiplier at or above `to`. `<= 1` renders zoomed-in bodies smaller than world. */
  toScale: number;
};

export type KindSizing = {
  /** Read `size` as CSS pixels directly, ignoring zoom. */
  screen?: boolean;
  /**
   * Damp world-space growth over a zoom band. Applied before {@link KindSizing.min} /
   * {@link KindSizing.max}, which stay on as absolute guard rails — with damping in
   * place they should rarely bind, which is the point.
   */
  damp?: SizeDamping;
  /** Floor the CSS pixel size. Below ~1 a body would vanish; at 1 it splats. */
  min?: number;
  /**
   * Ceil the CSS pixel size.
   *
   * Mind the *band*, not just the values: a world-space body lives between `min` and
   * `max` and is pinned outside them, so a narrow band makes a world-space layer feel
   * screen-space. A graph clamped to [3, 24] hit its ceiling by 4x zoom and held it
   * for every zoom beyond — a constant screen size, which is the thing world-space
   * sizing exists to avoid.
   */
  max?: number;
};

/** Rendering of inline labels (see {@link SharedComponentStore.label}). */
export type LabelSizing = {
  /** Font size in CSS pixels. */
  size?: number;
  /** CSS colour. Labels ignore their body's fill, as v1's `draw` did. */
  color?: string;
  /** Gap in CSS pixels between the body's edge and the label. */
  offset?: number;
  /**
   * Cell size in CSS pixels for the per-tile label grid. At most one label is
   * drawn per cell, the one on the highest-`size` body — which is what stops
   * labels crowding as you zoom out, without any viewport-global decluttering
   * pass (impossible here: tiles are rasterized independently, in parallel, and
   * cached against a content hash).
   *
   * Omit to draw every label.
   */
  grid?: Size;
};

export type Size = { width: number; height: number };

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
  /**
   * Per-kind pixel sizing. Because params never trigger a rebuild, this is what
   * turns node size, edge thickness and label size into live sliders: dragging
   * one re-composites from the tile cache instead of repacking the store.
   */
  sizing?: Partial<Record<ComponentKind, KindSizing>>;
  /** Inline label rendering. */
  label?: LabelSizing;
};
