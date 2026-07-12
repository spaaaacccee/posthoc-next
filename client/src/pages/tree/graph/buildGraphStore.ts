import interpolate from "color-interpolate";
import type { ColorRamp, LayerParams, SharedComponentStore } from "renderer";
import type { Trace, TraceEvent } from "protocol/Trace-v140";

/**
 * Synthesizes a graph — nodes, edges, arrowheads, labels — as a
 * {@link SharedComponentStore}, so the tree page renders through the same tiled,
 * worker-parallel, spatially-indexed renderer as the map view instead of through
 * sigma.
 *
 * The graph view is unlike the map view in that it does *not* consume the trace's
 * `views`: a trace author describes how to draw their search on a map, but the
 * *graph* is something we derive from `id`/`pId` and the event's own properties.
 * So this is a synthesizer, not a parser.
 *
 * Two structural decisions carry most of the weight:
 *
 * **One body per event, not per node.** A node revisited at steps 10 and 500 is
 * two bodies with disjoint spans `[10, 500)` and `[500, total)`. Only one is ever
 * visible, so the renderer still draws one circle — but the second body has its
 * own `start`, so its colour ramp restarts and the revisit *re-highlights*, which
 * is the behaviour sigma got by recolouring the node in place. It also means a
 * node whose position depends on the step (plot mode, where x/y come from event
 * properties that change) needs no special case: the bodies simply sit in
 * different places.
 *
 * **Colour is a ramp, not a value.** Rather than recolouring nodes as the playhead
 * moves — an O(visible) main-thread pass every step — each body carries a ramp id,
 * and the renderer resolves `palette[offset + bucket(step - start)]` at draw time.
 * There is one ramp per event type, fading that type's colour out towards the
 * background. See {@link SharedComponentStore.ramp}.
 */

const KIND_CIRCLE = 1;
const KIND_PATH = 2;
const ARROW_TRIANGLE = 1;

/**
 * Colours per ramp. The tile hash folds a body's *bucket*, so this is also the
 * quantization of the tile cache: a ramped tile re-rasterizes only when one of its
 * bodies crosses a bucket, i.e. every `window / RAMP_STEPS` steps rather than every
 * step. 16 is smooth enough to read as a gradient while still cutting the repaint
 * rate by ~16x during a scrub.
 */
const RAMP_STEPS = 16;

/** How faded a body is once its ramp saturates. 0 = the background exactly. */
const FLOOR = 0.25;

export type GraphMode = "tree" | "directed-graph" | "plot";

/** A node's laid-out position, from dagre. Keyed by `String(event.id)`. */
export type NodeLayout = { x: number; y: number; label: string; size: number };

export type BuildGraphStoreOptions = {
  trace?: Trace;
  mode: GraphMode;
  /** Tree and directed-graph modes: dagre's output. Ignored by plot mode. */
  layout?: NodeLayout[];
  orientation?: "horizontal" | "vertical";
  /** Plot mode: the event properties driving each axis. */
  x?: string;
  y?: string;
  /** Plot mode: symlog rather than linear. */
  log?: boolean;
  /** Event type -> CSS colour. Resolved on the main thread, from the theme. */
  colors: Record<string, string>;
  /** What a faded body tends towards; the viewport background. */
  background: string;
  edgeColor: string;
  labelColor: string;
  /** Steps a body takes to fade out. Sigma's equivalent was 400. */
  fadeWindow?: number;
  generation?: number;
};

/** World extent that plot-mode axes are mapped onto. */
const PLOT_SPAN = 1000;

/**
 * How a plot axis maps a data value onto a world coordinate. Returned so the axis
 * overlay can invert it to place ticks — the renderer itself neither knows nor
 * cares that a log scale exists, because the scale is applied here, at pack time.
 */
export type AxisScale = {
  property: string;
  min: number;
  max: number;
  log: boolean;
  span: number;
};

export type GraphStoreResult = {
  store: SharedComponentStore;
  /** Plot mode only. */
  scales?: { x: AxisScale; y: AxisScale };
  /** Content bounds in world space, for fitting the camera. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Bodies packed ahead of the nodes. Node body `i` is event `i - edgeCount`, and
   * that identity is the entire hit-test: the renderer reports a clicked *body
   * index*, and this maps it straight back to the event the user clicked, with no
   * second index and no lookup table.
   */
  edgeCount: number;
};

/** The event a clicked body refers to, or `undefined` if an edge was clicked. */
export const eventOf = (r: GraphStoreResult, body: number): number | undefined =>
  body >= r.edgeCount ? body - r.edgeCount : undefined;

/** symlog: linear near zero, logarithmic beyond it. Matches d3's scaleSymlog. */
const symlog = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v));

export const applyScale = (s: AxisScale, v: number): number => {
  const t = s.log ? symlog(v) : v;
  const lo = s.log ? symlog(s.min) : s.min;
  const hi = s.log ? symlog(s.max) : s.max;
  return hi === lo ? 0 : ((t - lo) / (hi - lo)) * s.span;
};

/** The data value at world coordinate `w`. The axis overlay's tick placement. */
export const invertScale = (s: AxisScale, w: number): number => {
  const lo = s.log ? symlog(s.min) : s.min;
  const hi = s.log ? symlog(s.max) : s.max;
  const t = lo + (w / s.span) * (hi - lo);
  return s.log ? Math.sign(t) * Math.expm1(Math.abs(t)) : t;
};

function sab<T extends Uint8Array | Int32Array | Float32Array>(
  Ctor: new (buffer: SharedArrayBuffer) => T,
  bytes: number,
  length: number,
): T {
  return new Ctor(new SharedArrayBuffer(Math.max(1, length) * bytes));
}

export function buildGraphStore({
  trace,
  mode,
  layout,
  orientation = "vertical",
  x: xProp = "g",
  y: yProp = "f",
  log = false,
  colors,
  background,
  edgeColor,
  labelColor,
  fadeWindow = 400,
  generation = 0,
}: BuildGraphStoreOptions): GraphStoreResult {
  const events: TraceEvent[] = trace?.events ?? [];
  const n = events.length;
  const total = Math.max(1, n);

  // ---- Palette: one ramp per event type, plus the flat edge and label colours.
  //
  // A ramp's colours must be *contiguous* in the palette, because that is what
  // lets a ramped body still resolve to a plain palette index at draw time.
  const palette: string[] = [""];
  const ramps: ColorRamp[] = [];
  const rampOf = new Map<string, number>();
  for (const type of new Set(events.map((e) => String(e.type ?? "")))) {
    const base = colors[type] ?? colors[""] ?? "#888888";
    const fade = interpolate([base, background]);
    const offset = palette.length;
    for (let k = 0; k < RAMP_STEPS; k++) {
      // Saturate at FLOOR rather than at the background: a fully-faded node must
      // stay visible, or the graph erases itself behind the playhead.
      palette.push(fade((k / (RAMP_STEPS - 1)) * (1 - FLOOR)));
    }
    ramps.push({ offset, length: RAMP_STEPS, window: fadeWindow });
    // +1: ramp 0 means "no ramp, use `fill`".
    rampOf.set(type, ramps.length);
  }
  const edgeFill = palette.push(edgeColor) - 1;

  // ---- Positions.
  //
  // Tree and directed-graph read dagre's layout, so every event on a node lands at
  // the same place. Plot reads the event's own properties, so they don't — which is
  // exactly the axis the hybrid view will let users choose, and is why positions
  // are resolved per *event* rather than per node.
  const horizontal = orientation === "horizontal";
  const nodes = new Map<string, NodeLayout>();
  for (const l of layout ?? []) nodes.set(l.label, l);

  let scales: GraphStoreResult["scales"];
  if (mode === "plot") {
    scales = { x: axisOf(events, xProp, log), y: axisOf(events, yProp, log) };
  }

  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    if (mode === "plot") {
      px[i] = applyScale(scales!.x, num(e[scales!.x.property]));
      py[i] = applyScale(scales!.y, num(e[scales!.y.property]));
    } else {
      const l = nodes.get(String(e.id));
      // Rotation swaps the axes on the *positions*, not in dagre — the layout is
      // cached across orientation changes, so rotating must not re-run it.
      px[i] = l ? (horizontal ? -l.y : l.x) : 0;
      py[i] = l ? (horizontal ? l.x : l.y) : 0;
    }
  }

  // ---- Spans, and they differ by mode — this is the one place the two views
  // genuinely disagree about what a body *is*.
  //
  // In tree and directed-graph modes a node has a single position, so its events
  // are successive states of one circle: the bodies are given *disjoint* spans, so
  // exactly one is alive at any step. The renderer draws one circle, and a revisit
  // starts a new body whose ramp restarts — which is how a revisit re-highlights.
  //
  // In plot mode every event is a *distinct point*: its x/y come from the event's
  // own properties, so two events on one node land in different places, and the
  // scatter cloud must accumulate. Bodies are persistent. This is also why plot
  // mode is the mode that reaches the big numbers — 717k events is 717k live
  // bodies, where the tree of the same trace is 25k.
  const persistent = mode === "plot";
  const until = new Int32Array(n);
  if (persistent) until.fill(total);
  else {
    const last = new Map<string, number>();
    for (let i = n - 1; i >= 0; i--) {
      const id = String(events[i]!.id);
      until[i] = last.get(id) ?? total;
      last.set(id, i);
    }
  }

  // ---- Edges. One body per distinct (id -> pId), first appearance onward.
  // `size` accumulates a visit count, so a heavily-traversed edge draws thicker —
  // the same signal sigma got by bumping the edge's size attribute per event.
  type Edge = { from: string; to: string; at: number; visits: number; ramp: number };
  const edges = new Map<string, Edge>();
  if (mode !== "plot") {
    // A tree keeps only each node's *final* parent, so a re-parented node has one
    // edge; a directed graph keeps every parent it ever had.
    const finalParent = new Map<string, string>();
    if (mode === "tree") {
      for (const e of events) {
        if (e.pId != null) finalParent.set(String(e.id), String(e.pId));
      }
    }
    for (let i = 0; i < n; i++) {
      const e = events[i]!;
      if (e.pId == null) continue;
      const id = String(e.id);
      const pId = String(e.pId);
      if (mode === "tree" && finalParent.get(id) !== pId) continue;
      const key = `${id}::${pId}`;
      const existing = edges.get(key);
      if (existing) existing.visits++;
      else {
        edges.set(key, {
          from: id,
          to: pId,
          at: i,
          visits: 1,
          ramp: rampOf.get(String(e.type ?? "")) ?? 0,
        });
      }
    }
  }

  // ---- Pack. Edges first, then nodes: `queryVisible` returns indices ascending,
  // so body order *is* draw order, and edges must sit under nodes. Labels are
  // inline on the node body, so they need no bodies of their own and are painted
  // last within each node's draw.
  const nEdge = edges.size;
  const count = nEdge + n;
  const store: SharedComponentStore = {
    generation,
    count,
    total,
    kind: sab(Uint8Array, 1, count),
    x: sab(Float32Array, 4, count),
    y: sab(Float32Array, 4, count),
    size: sab(Float32Array, 4, count),
    size2: sab(Float32Array, 4, count),
    alpha: sab(Float32Array, 4, count),
    start: sab(Int32Array, 4, count),
    end: sab(Int32Array, 4, count),
    fill: sab(Int32Array, 4, count),
    palette,
    label: sab(Int32Array, 4, count),
    strings: [""],
    ptOff: sab(Int32Array, 4, count + 1),
    pts: sab(Float32Array, 4, nEdge * 4),
    arrow: sab(Uint8Array, 1, count),
    ramp: sab(Uint8Array, 1, count),
    ramps,
  };

  // Positions of a node's *first* body: an edge is drawn between laid-out node
  // positions, which in tree/DAG mode never move.
  const firstOf = new Map<string, number>();
  for (let i = n - 1; i >= 0; i--) firstOf.set(String(events[i]!.id), i);

  let b = 0;
  let pt = 0;
  const arrowPacked = ARROW_TRIANGLE << 4; // end only; start = none
  for (const e of edges.values()) {
    const a = firstOf.get(e.from);
    const c = firstOf.get(e.to);
    if (a === undefined || c === undefined) continue;
    store.kind[b] = KIND_PATH;
    store.pts[pt] = px[a]!;
    store.pts[pt + 1] = py[a]!;
    store.pts[pt + 2] = px[c]!;
    store.pts[pt + 3] = py[c]!;
    pt += 4;
    store.ptOff[b + 1] = pt / 2;
    // Line width in world units; the layer clamps it into a pixel range.
    store.size[b] = 1 + Math.log(e.visits);
    store.size2[b] = 8; // arrowhead size, in screen pixels
    store.arrow[b] = arrowPacked;
    store.alpha[b] = 1;
    store.start[b] = e.at;
    store.end[b] = total;
    store.fill[b] = edgeFill;
    store.ramp[b] = e.ramp;
    b++;
  }
  // `b` may now trail `nEdge`: an edge whose endpoints never resolved was skipped,
  // leaving unused trailing slots. `store.count` is set from `b` at the end, so
  // they are never read. Node bodies start here, which is what makes a clicked
  // body index invertible back to an event (see `eventOf`).
  const edgeCount = b;

  const visits = new Map<string, number>();
  const strings = store.strings;
  const stringOf = new Map<string, number>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const id = String(e.id);
    const v = (visits.get(id) ?? 0) + 1;
    visits.set(id, v);

    const X = px[i]!;
    const Y = py[i]!;
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Y < minY) minY = Y;
    if (Y > maxY) maxY = Y;

    store.kind[b] = KIND_CIRCLE;
    store.x[b] = X;
    store.y[b] = Y;
    // Doubles as the label grid's importance, so a much-visited node keeps its
    // label when a quiet neighbour loses it.
    store.size[b] = 2 + Math.log(v);
    store.alpha[b] = 1;
    store.start[b] = i;
    store.end[b] = until[i]!;
    store.ramp[b] = rampOf.get(String(e.type ?? "")) ?? 0;
    store.fill[b] = 0;
    let s = stringOf.get(id);
    if (s === undefined) {
      s = strings.length;
      strings.push(id);
      stringOf.set(id, s);
    }
    store.label[b] = s;
    store.ptOff[b + 1] = pt / 2;
    b++;
  }

  store.count = b;
  return {
    store,
    scales,
    edgeCount,
    bounds: n ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: PLOT_SPAN, maxY: PLOT_SPAN },
  };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function axisOf(events: TraceEvent[], property: string, log: boolean): AxisScale {
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const v = num(e[property]);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (min === max) max = min + 1;
  return { property, min, max, log, span: PLOT_SPAN };
}

/**
 * The sizing and label policy a graph layer renders under.
 *
 * These live in {@link LayerParams} rather than in the store precisely so they can
 * change without a rebuild: node size, edge width and label size are all live
 * sliders, and dragging one re-rasterizes but never repacks a column or rebuilds
 * the spatial index.
 */
export const graphLayerParams = (labelColor: string): LayerParams => ({
  sizing: {
    // World-space, so nodes spread apart as you zoom in — but clamped, because a
    // node that keeps growing becomes a blob and one that keeps shrinking
    // vanishes.
    //
    // The floor is exactly 1, and that is load-bearing rather than a round number:
    // `drawBody` splats a single pixel when a circle's radius is <= 1px, and that
    // splat is what stops fill rate scaling with node count. A floor of 1.5 would
    // keep every node just above the threshold, so a fully zoomed-out million-node
    // graph would stroke a million ellipses — the LOD path would exist and never
    // once run.
    circle: { min: 1, max: 20 },
    path: { min: 1, max: 6 },
  },
  label: {
    size: 12,
    color: labelColor,
    offset: 4,
    // One label per cell. Sized so a 512px tile holds ~8x16 of them.
    grid: { width: 64, height: 32 },
  },
});
