import type { SharedComponentStore } from "renderer";
import { getFillStyle } from "./primitives";

/**
 * Columnar draw path: rasterize a body straight from the store's typed-array
 * columns — no per-body object materialization, no JSON parse. Mirrors the
 * geometry of `primitives.draw` for rect and circle (the first slice).
 */

const { ceil, PI } = Math;

// Kind indices, matching COMPONENT_KINDS order.
const CIRCLE = 1;
const PATH = 2;
const POLYGON = 3;
const TEXT = 4;

const GREY = "#808080";

/** Maps world coords into tile pixels: `px = world * s + t`. */
export type DrawTransform = { x: number; y: number; sx: number; sy: number };

/** Transform mapping a tile's world bounds onto its pixel canvas. */
export function columnarDrawTransform(
  bounds: { top: number; left: number; right: number; bottom: number },
  tile: { width: number; height: number },
): DrawTransform {
  const sx = tile.width / (bounds.right - bounds.left);
  const sy = tile.height / (bounds.bottom - bounds.top);
  return { sx, sy, x: -bounds.left * sx, y: -bounds.top * sy };
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
>;

/**
 * Resolve a body's fill+alpha to a CSS colour string, memoized per
 * (paletteCode, quantized-alpha) so each distinct colour is parsed once — not
 * once per body per frame as the old `getFillStyle`-in-`draw` path did.
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

/** Draw body `i` onto `ctx` under transform `t`. */
export function drawBody(
  store: SharedComponentStore,
  i: number,
  ctx: Ctx2D,
  t: DrawTransform,
  cache: Map<number, string>,
): void {
  const style = resolveFill(store, store.fill[i]!, store.alpha[i]!, cache);
  const kind = store.kind[i];
  if (kind === CIRCLE) {
    ctx.fillStyle = style;
    const x = store.x[i]! * t.sx + t.x;
    const y = store.y[i]! * t.sy + t.y;
    ctx.beginPath();
    ctx.ellipse(ceil(x), ceil(y), ceil(store.size[i]! * t.sx), ceil(store.size[i]! * t.sy), 0, 0, 2 * PI);
    ctx.fill();
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
      ctx.lineWidth = ceil(store.size[i]! * t.sx) || 1;
      ctx.stroke();
    }
  } else if (kind === TEXT) {
    const str = store.strings[store.label[i]!];
    if (!str) return;
    ctx.fillStyle = style;
    ctx.font = `${store.size[i]! * t.sx}px Inter, Helvetica, Arial, sans-serif`;
    ctx.fillText(str, store.x[i]! * t.sx + t.x, store.y[i]! * t.sy + t.y);
  } else {
    // rect
    ctx.fillStyle = style;
    const x = store.x[i]! * t.sx + t.x;
    const y = store.y[i]! * t.sy + t.y;
    ctx.fillRect(ceil(x), ceil(y), ceil(store.size[i]! * t.sx) || 1, ceil(store.size2[i]! * t.sy) || 1);
  }
}
