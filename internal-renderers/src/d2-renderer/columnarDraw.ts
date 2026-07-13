import type {
  ComponentKind,
  KindSizing,
  LabelSizing,
  LayerParams,
  SharedComponentStore,
  SizeDamping,
} from "renderer";
import { alignOf, arrowEnd, arrowStart, baselineOf, shadeOf } from "renderer";
import { getFillStyle } from "./primitives";

/**
 * Columnar draw path: rasterize a body straight from the store's typed-array
 * columns — no per-body object materialization, no JSON parse.
 */

const { ceil, round, PI, sqrt } = Math;

// Kind indices, matching COMPONENT_KINDS order.
const CIRCLE = 1;
const PATH = 2;
const POLYGON = 3;
const TEXT = 4;

// Arrow shape indices, matching ARROW_SHAPES order. Only these two are drawn.
const ARROW_NONE = 0;
const ARROW_TRIANGLE = 1;

const CANVAS_ALIGNS = ["left", "center", "right"] as const;
const CANVAS_BASELINES = ["alphabetic", "top", "middle", "bottom"] as const;

const GREY = "#808080";

/**
 * Circles at or below this **CSS** pixel radius are splatted as a filled rect rather
 * than stroked as an ellipse.
 *
 * `beginPath` + `ellipse` + `fill` is roughly an order of magnitude dearer than one
 * `fillRect`, and it buys nothing here: at a radius of 2px a circle and a square are
 * the same handful of pixels, and at these sizes the eye is reading a density cloud,
 * not individual nodes. This is the single measure that decouples frame cost from node
 * count — a 717k-point scatter fitted to the viewport draws every node at ~2px, so
 * *all* of it takes this path.
 *
 * The threshold is perceptual — "small enough on screen that a square reads as a dot"
 * — so it is a CSS size, and `drawBody` scales it by `pixelScale` to reach the tile's
 * own pixels. A tile-pixel threshold would mean something different on every display
 * and at every zoom.
 */
export const SPLAT_RADIUS_PX = 2;

/** Normalise -0, which is a distinct value under Object.is and leaks into tests. */
const nz = (v: number) => (v === 0 ? 0 : v);

/** Maps world coords into tile pixels: `px = world * s + t`. */
export type DrawTransform = { x: number; y: number; sx: number; sy: number };

/** Transform mapping a tile's world bounds onto its pixel canvas. */
export function columnarDrawTransform(
  bounds: { top: number; left: number; right: number; bottom: number },
  tile: { width: number; height: number },
): DrawTransform {
  const sx = tile.width / (bounds.right - bounds.left);
  const sy = tile.height / (bounds.bottom - bounds.top);
  // Negating a zero origin yields -0, which is a distinct value under Object.is
  // (and so leaks into hashes/comparisons). Normalise it.
  const norm = (v: number) => (v === 0 ? 0 : v);
  return { sx, sy, x: norm(-bounds.left * sx), y: norm(-bounds.top * sy) };
}

/** Minimal 2D context surface used by `drawBody` (real or stubbed in tests). */
export type Ctx2D = Pick<
  OffscreenCanvasRenderingContext2D,
  | "fillStyle"
  | "fillRect"
  | "beginPath"
  | "ellipse"
  | "fill"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "stroke"
  | "font"
  | "fillText"
  | "textAlign"
  | "textBaseline"
>;

/**
 * Everything the draw path needs beyond the body itself: the playhead (ramps
 * resolve against it), and the layer's pixel-sizing and label policy — which
 * live in {@link LayerParams} precisely so they can change without repacking the
 * store.
 */
export type DrawOptions = {
  /** Playhead. Drives {@link shadeOf}; ignored by bodies with no ramp. */
  step: number;
  sizing?: LayerParams["sizing"];
  label?: LabelSizing;
  /**
   * Which bodies won their label cell, from {@link buildLabelGrid}. Omit to draw
   * every label.
   */
  labels?: Set<number>;
  /**
   * **Tile pixels per CSS pixel.** Every screen-space quantity reaching this module
   * — size clamps, `screen` sizes, label fonts, arrowheads, the splat threshold — is
   * stated in CSS pixels and multiplied by this to reach the tile's own units.
   *
   * It is not a constant, and that is the whole reason it has to be passed in. A tile
   * rasterizes into a fixed-size bitmap that is then *stretched* over its world bounds,
   * so a tile pixel is not a fixed amount of screen: how much depends on the display's
   * dpr, the pane's width and how hard the frustum is subdivided. Treating tile pixels
   * as CSS pixels (which is what omitting this does) makes a "12px" label render at 5px
   * on one machine and 12 on another.
   *
   * **It is a nominal figure, anchored to the tile grid rather than to the camera** —
   * see `D2RendererV2Worker.#tileCssSize`. A body sized in CSS pixels therefore holds
   * its screen size only *approximately* through a zoom, breathing by up to a factor of
   * sqrt(2) either way across an octave. That is deliberate: an exact scale would
   * re-rasterize every tile in the frustum continuously as you zoom, and the flicker
   * costs far more than the drift.
   *
   * Defaults to 1, which is exactly right for a caller drawing straight to the screen.
   */
  pixelScale?: number;
};

/**
 * Resolve a body's fill+alpha to a CSS colour string, memoized per
 * (paletteCode, quantized-alpha) so each distinct colour is parsed once — not
 * once per body per frame.
 *
 * Ramped bodies resolve to a palette index like any other (see {@link shadeOf}),
 * so a colour that changes every step costs no more to shade than a static one.
 */
export function resolveFill(
  store: SharedComponentStore,
  fillCode: number,
  alpha: number,
  cache: Map<number, string>,
): string {
  const a = Math.min(255, Math.max(0, Math.round(alpha * 255)));
  const key = fillCode * 256 + a;
  let s = cache.get(key);
  if (s === undefined) {
    s = getFillStyle(store.palette[fillCode] || GREY, alpha);
    cache.set(key, s);
  }
  return s;
}

/**
 * A body's CSS `font`, memoized on its pixel size. Every text body in a tile is
 * usually the same size, and both the template string and the UA's font-shorthand
 * parse are otherwise paid once per body per frame.
 */
let lastFontSize = NaN;
let lastFont = "";
function fontFor(size: number): string {
  if (size !== lastFontSize) {
    lastFontSize = size;
    lastFont = `${size}px Inter, Helvetica, Arial, sans-serif`;
  }
  return lastFont;
}

/**
 * A world `size` in pixels, under this kind's sizing policy.
 *
 * With no policy this is the original `size * scale` — pure world space, which is
 * what a map wants. A graph clamps into a pixel range instead (a node that keeps
 * growing becomes a blob; one that keeps shrinking vanishes), and pins labels and
 * arrowheads to a fixed pixel size with `screen`.
 */
export function pxSize(size: number, scale: number, s?: KindSizing, pixelScale = 1): number {
  // World sizes convert through `scale`; CSS sizes, the damping knees and the clamps
  // convert through `pixelScale`. Mixing them up is what made `min`/`max` mean 4-9x
  // less than they said — see `DrawOptions.pixelScale`.
  let px = s?.screen ? size * pixelScale : size * scale;
  // Damp before clamping. A clamp *pins*; damping only bends. Doing it the other way
  // round would pin first and then bend a constant, which is not a size policy at all.
  if (s?.damp && !s.screen) px = dampen(px, s.damp, pixelScale);
  const min = s?.min === undefined ? undefined : s.min * pixelScale;
  const max = s?.max === undefined ? undefined : s.max * pixelScale;
  if (min !== undefined && px < min) px = min;
  if (max !== undefined && px > max) px = max;
  return px;
}

/**
 * Scale `px` (a natural, world-space size in *tile* pixels) by the damping policy.
 *
 * The interpolation is geometric in both axes — the scale moves linearly in log space
 * as the size does — which is what makes the result a smooth power law rather than
 * something with a visible kink at each knee: the drawn size ends up proportional to
 * `natural ^ e`, where `e = 1 + log(toScale / fromScale) / log(to / from)`. At `e = 1`
 * it is world-space; at `e = 0`, screen-space; in between, the "screen-space-ish"
 * middle. `e < 0` would mean a body that *shrinks* as you zoom in, which is why the
 * scale ratio should not exceed the size ratio.
 */
function dampen(px: number, d: SizeDamping, pixelScale: number): number {
  const from = d.from * pixelScale;
  const to = d.to * pixelScale;
  if (px <= 0 || !(to > from) || from <= 0) return px;
  const t = Math.log(px / from) / Math.log(to / from);
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return px * d.fromScale * (d.toScale / d.fromScale) ** u;
}

/**
 * The largest pixel extent a body of this kind can reach beyond its indexed
 * world bbox. See {@link screenPad}.
 *
 * A world-space kind with no clamp reaches nothing extra — its bbox is exact, and
 * that is the map's case, so the map pays nothing for any of this. A clamped kind
 * is bounded by its own `max`. An unclamped screen-space kind has no principled
 * bound, so it gets a generous constant; set `max` if that matters.
 */
function kindPad(s?: KindSizing): number {
  if (s?.max !== undefined) return s.max;
  if (s?.screen) return 64;
  return 0;
}

/**
 * How far, in **world units**, a body's drawn extent can exceed the bbox the
 * spatial index holds for it.
 *
 * The index is world-space, but a screen-space or pixel-clamped body's world
 * footprint depends on the zoom — so a query for a tile's exact bounds can miss a
 * body that is *anchored* just outside it yet *drawn* inside it. Inflating the
 * query by this much fixes that.
 *
 * It also fixes a pre-existing bug: text straddling a tile edge used to clip
 * (see `bodyBounds`). With the query inflated, both tiles draw it, and because
 * `columnarDrawTransform` is consistent across tiles at one zoom, the two halves
 * land on the same subpixel and the seam is invisible.
 */
export function screenPad(store: SharedComponentStore, scale: number, o: DrawOptions): number {
  const kinds: ComponentKind[] = ["rect", "circle", "path", "polygon", "text"];
  let px = 0;
  for (const k of kinds) {
    const p = kindPad(o.sizing?.[k]);
    if (p > px) px = p;
  }
  // An arrowhead is drawn *inward* from its terminal vertex (see `arrowInset`), so it
  // never reaches past the path's own bbox along the line — only sideways, by half its
  // width.
  if (store.arrow) px += 16;
  // An inline label runs off its body by the offset plus the width of the text. Guess
  // that from the store's *longest* string rather than from a blanket 16 characters:
  // the pad inflates every tile's query on all four sides, and now that it is honestly
  // in CSS pixels a 16-char guess at 12px is ~200px a side — several times the tile.
  if (o.label) {
    px += maxLabelChars(store) * (o.label.size ?? 12) * CHAR_WIDTH + (o.label.offset ?? 4);
  }
  // `px` is CSS; `scale` is tile-px-per-world. Convert CSS -> tile -> world.
  return (px * (o.pixelScale ?? 1)) / scale;
}

/** Rough advance width of a character, as a fraction of the font size. */
const CHAR_WIDTH = 0.62;

/** Longest string in a store, memoized — `strings` is immutable per generation. */
const longest = new WeakMap<SharedComponentStore, number>();
function maxLabelChars(store: SharedComponentStore): number {
  let n = longest.get(store);
  if (n === undefined) {
    n = 0;
    for (const s of store.strings) if (s.length > n) n = s.length;
    longest.set(store, n);
  }
  return n;
}

/**
 * Pick at most one label per grid cell — the one on the highest-`size` body.
 *
 * This is the whole decluttering strategy, and its shape is forced by the
 * architecture. Sigma declutters against the *viewport*: grid the screen, keep
 * the biggest node per cell, every frame, on the main thread. That is impossible
 * here — tiles are rasterized independently and in parallel, and cached against a
 * content hash, so a tile's pixels must be a pure function of (bounds, scale,
 * step). A label whose visibility depended on a neighbouring tile, or on where
 * the camera happens to sit, would make that hash a lie.
 *
 * So the grid lives *inside the tile*, in cells derived from the tile's own
 * bounds. Three things fall out, and together they make this better than the
 * thing it replaces rather than a concession to it:
 *
 *  - **Stable under panning.** Tiles are snapped to a world-anchored power-of-two
 *    grid (see `getTiles`), so cells don't move when you drag. Sigma's labels pop
 *    in and out, because its cells are pinned to the screen.
 *  - **LOD for free.** Zoom in, and a tile covers less world at the same pixel
 *    size, so the same cell budget yields more labels per unit area. That *is*
 *    "more labels as you zoom in", with no threshold to tune.
 *  - **Correct while scrubbing.** The caller passes only the bodies visible at
 *    this step, so early in a trace, when few nodes exist, they all get labelled —
 *    nothing is competing. A precomputed per-node "label rank" column, the other
 *    obvious design, would thin against the *final* node set and leave you staring
 *    at an almost unlabelled graph at step 100.
 *
 * The wart: a label anchored near a tile corner only competes within its own tile,
 * so labels can cluster slightly at boundaries. In practice it is invisible.
 */
export function buildLabelGrid(
  store: SharedComponentStore,
  indices: ArrayLike<number>,
  t: DrawTransform,
  tile: { width: number; height: number },
  label: LabelSizing,
  pixelScale = 1,
): Set<number> | undefined {
  const grid = label.grid;
  if (!grid) return undefined;
  // The cell is a CSS-pixel budget — "one label per 64x32 of screen" — so it has to
  // be measured against the tile in the tile's own pixels.
  const cellW = grid.width * pixelScale;
  const cellH = grid.height * pixelScale;
  const cols = Math.max(1, ceil(tile.width / cellW));
  const rows = Math.max(1, ceil(tile.height / cellH));
  // Winner per cell, and its importance. -1 = empty.
  const winner = new Int32Array(cols * rows).fill(-1);
  const best = new Float32Array(cols * rows);

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    if (!store.label[i]) continue;
    const px = store.x[i]! * t.sx + t.x;
    const py = store.y[i]! * t.sy + t.y;
    let cx = Math.floor(px / cellW);
    let cy = Math.floor(py / cellH);
    // A body anchored just outside the tile (the query is inflated, so there are
    // some) still competes, from the edge cell it is nearest.
    cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
    cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
    const cell = cy * cols + cx;
    const importance = store.size[i]!;
    if (winner[cell] === -1 || importance > best[cell]!) {
      winner[cell] = i;
      best[cell] = importance;
    }
  }

  const out = new Set<number>();
  for (let c = 0; c < winner.length; c++) if (winner[c] !== -1) out.add(winner[c]!);
  return out;
}

/**
 * An arrowhead at `(tx, ty)`, pointing along the unit vector `(dx, dy)`.
 *
 * Derived at draw time from the path's terminal vertex rather than stored as its
 * own polygon body: a stored head would double the edge count, and — since it is
 * sized in screen pixels — would have to be regenerated on every zoom change.
 */
function drawArrowhead(
  ctx: Ctx2D,
  tx: number,
  ty: number,
  dx: number,
  dy: number,
  size: number,
  shape: number,
): void {
  if (shape !== ARROW_TRIANGLE) return;
  const half = size * 0.5;
  // Base of the head, and the perpendicular to spread its corners along.
  const bx = tx - dx * size;
  const by = ty - dy * size;
  const px = -dy;
  const py = dx;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx + px * half, by + py * half);
  ctx.lineTo(bx - px * half, by - py * half);
  ctx.closePath();
  ctx.fill();
}

/** An inline label on a non-text body, offset clear of its owner's edge. */
function drawInlineLabel(
  store: SharedComponentStore,
  i: number,
  ctx: Ctx2D,
  cx: number,
  cy: number,
  radius: number,
  o: DrawOptions,
): void {
  const str = store.strings[store.label[i]!];
  if (!str) return;
  if (o.labels && !o.labels.has(i)) return;
  const l = o.label!;
  const k = o.pixelScale ?? 1;
  // Font size and offset are CSS pixels; the canvas we are drawing into is measured
  // in tile pixels.
  const size = (l.size ?? 12) * k;
  const a = store.align?.[i] ?? 0;
  ctx.font = fontFor(size);
  ctx.fillStyle = l.color ?? GREY;
  ctx.textAlign = CANVAS_ALIGNS[alignOf(a)] ?? "left";
  ctx.textBaseline = CANVAS_BASELINES[baselineOf(a)] ?? "middle";
  ctx.fillText(str, cx + radius + (l.offset ?? 4) * k, cy);
}

/** Draw body `i` onto `ctx` under transform `t`. */
export function drawBody(
  store: SharedComponentStore,
  i: number,
  ctx: Ctx2D,
  t: DrawTransform,
  cache: Map<number, string>,
  o: DrawOptions,
): void {
  const style = resolveFill(store, shadeOf(store, i, o.step), store.alpha[i]!, cache);
  const kind = store.kind[i];
  const sizing = o.sizing;
  const k = o.pixelScale ?? 1;

  if (kind === CIRCLE) {
    ctx.fillStyle = style;
    const x = store.x[i]! * t.sx + t.x;
    const y = store.y[i]! * t.sy + t.y;
    const s = sizing?.circle;
    const rx = pxSize(store.size[i]!, t.sx, s, k);
    const ry = pxSize(store.size[i]!, t.sy, s, k);
    // The splat threshold is perceptual — "small enough on *screen* that a square
    // reads as a dot" — so it is a CSS size, converted here like any other.
    const splat = SPLAT_RADIUS_PX * k;
    if (rx <= splat && ry <= splat) {
      // Small enough that a square reads as a dot: splat. See SPLAT_RADIUS_PX.
      ctx.fillRect(nz(round(x - rx)), nz(round(y - ry)), ceil(rx * 2) || 1, ceil(ry * 2) || 1);
    } else {
      ctx.beginPath();
      ctx.ellipse(ceil(x), ceil(y), ceil(rx), ceil(ry), 0, 0, 2 * PI);
      ctx.fill();
    }
    if (o.label && store.label[i]) drawInlineLabel(store, i, ctx, x, y, rx, o);
  } else if (kind === PATH || kind === POLYGON) {
    const from = store.ptOff[i]! * 2;
    const to = store.ptOff[i + 1]! * 2;
    if (to <= from) return;
    ctx.beginPath();
    ctx.moveTo(ceil(store.pts[from]! * t.sx + t.x), ceil(store.pts[from + 1]! * t.sy + t.y));
    for (let p = from + 2; p < to; p += 2) {
      ctx.lineTo(ceil(store.pts[p]! * t.sx + t.x), ceil(store.pts[p + 1]! * t.sy + t.y));
    }
    if (kind === POLYGON) {
      ctx.fillStyle = style;
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = style;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = ceil(pxSize(store.size[i]!, t.sx, sizing?.path, k)) || 1;
      ctx.stroke();
      const a = store.arrow?.[i] ?? 0;
      if (a) drawArrows(store, i, ctx, t, from, to, a, style, o);
    }
    if (o.label && store.label[i]) {
      const x = store.pts[from]! * t.sx + t.x;
      const y = store.pts[from + 1]! * t.sy + t.y;
      drawInlineLabel(store, i, ctx, x, y, 0, o);
    }
  } else if (kind === TEXT) {
    const str = store.strings[store.label[i]!];
    if (!str) return;
    if (o.labels && !o.labels.has(i)) return;
    ctx.fillStyle = style;
    ctx.font = fontFor(pxSize(store.size[i]!, t.sx, sizing?.text, k));
    const a = store.align?.[i] ?? 0;
    ctx.textAlign = CANVAS_ALIGNS[alignOf(a)] ?? "left";
    ctx.textBaseline = CANVAS_BASELINES[baselineOf(a)] ?? "alphabetic";
    ctx.fillText(str, store.x[i]! * t.sx + t.x, store.y[i]! * t.sy + t.y);
  } else {
    // rect
    ctx.fillStyle = style;
    const x = store.x[i]! * t.sx + t.x;
    const y = store.y[i]! * t.sy + t.y;
    const s = sizing?.rect;
    ctx.fillRect(
      ceil(x),
      ceil(y),
      ceil(pxSize(store.size[i]!, t.sx, s, k)) || 1,
      ceil(pxSize(store.size2[i]!, t.sy, s, k)) || 1,
    );
    if (o.label && store.label[i]) drawInlineLabel(store, i, ctx, x, y, 0, o);
  }
}

/**
 * Both ends of a path's arrowheads, sized in screen pixels from `size2`.
 *
 * The head is pulled back off its terminal vertex by {@link
 * SharedComponentStore.arrowInset}. Without that it is drawn *at* the vertex — which
 * in a graph is a node's centre — and since nodes are packed after edges, they paint
 * straight over it: an 8px head under a 3-24px circle is simply invisible.
 */
function drawArrows(
  store: SharedComponentStore,
  i: number,
  ctx: Ctx2D,
  t: DrawTransform,
  from: number,
  to: number,
  packed: number,
  style: string,
  o: DrawOptions,
): void {
  const n = (to - from) / 2;
  if (n < 2) return;
  const k = o.pixelScale ?? 1;
  // `size2` is the head's size in CSS pixels.
  const size = (store.size2[i]! || 8) * k;
  // The target's own drawn radius, under the policy that will draw it. Guarded on
  // being non-zero: `pxSize(0, ...)` would return the circle policy's *minimum*, so
  // a body with no inset would silently gain one.
  const world = store.arrowInset?.[i] ?? 0;
  const inset = world ? pxSize(world, t.sx, o.sizing?.circle, k) : 0;
  ctx.fillStyle = style;

  const end = arrowEnd(packed);
  if (end !== ARROW_NONE) {
    const tx = store.pts[to - 2]! * t.sx + t.x;
    const ty = store.pts[to - 1]! * t.sy + t.y;
    const qx = store.pts[to - 4]! * t.sx + t.x;
    const qy = store.pts[to - 3]! * t.sy + t.y;
    const dx = tx - qx;
    const dy = ty - qy;
    const len = sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      drawArrowhead(ctx, tx - ux * inset, ty - uy * inset, ux, uy, size, end);
    }
  }

  const start = arrowStart(packed);
  if (start !== ARROW_NONE) {
    const tx = store.pts[from]! * t.sx + t.x;
    const ty = store.pts[from + 1]! * t.sy + t.y;
    const qx = store.pts[from + 2]! * t.sx + t.x;
    const qy = store.pts[from + 3]! * t.sy + t.y;
    const dx = tx - qx;
    const dy = ty - qy;
    const len = sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      drawArrowhead(ctx, tx - ux * inset, ty - uy * inset, ux, uy, size, start);
    }
  }
}
