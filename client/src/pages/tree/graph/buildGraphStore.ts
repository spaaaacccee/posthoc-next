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

/**
 * World radius per unit of `2 + log(visits)`, **in tree and directed-graph modes
 * only**.
 *
 * Radii there are world-space, so they have to be expressed in the *layout's* units
 * or they render at the wrong scale — and dagre's units are set by its own
 * `nodesep`/`ranksep` (~50 and 100), not by anything here. A bare radius of 2
 * against a 50-unit node gap is a speck: fitted to the viewport it lands under a
 * pixel and clamps to the floor, which is exactly the "nodes are way too small"
 * failure. Sigma never hit this because its sizes were screen-space.
 *
 * It must not touch plot mode. See {@link plotMarkerPx}.
 */
const NODE_SCALE = 10;

/**
 * A scatter point's radius, in **screen pixels**.
 *
 * Screen-space, and that is the whole point. A plot's world span is a *constant*
 * ({@link PLOT_SPAN}), not something the trace sets, so a world-space radius is a
 * fixed fraction of the axis rather than a size: at `NODE_SCALE` a point was 20
 * world units across a 1000-unit plot — 2% of the whole chart, each — which fitted
 * to the viewport is a 20px blob drawn 717,447 times, over an index whose boxes are
 * then so much larger than a tile that every point lands in ~13 of them. That is a
 * 9.2M-ellipse frame for a 717k-point plot, and it is why this is not a knob shared
 * with the tree.
 *
 * It shrinks as the cloud grows, which is what keeps the splat path (see
 * `SPLAT_RADIUS_PX`) reachable on the traces that actually need it: past ~100k
 * points a marker is a density sample rather than a node, and 2px is both legible
 * and a single `fillRect`. Below that a plot is sparse enough that ellipses are
 * free, so legibility wins instead.
 */
const plotMarkerPx = (n: number): number => (n >= 100_000 ? 2 : n >= 10_000 ? 3 : 5);

/**
 * Arrowhead size, and the width of an edge.
 *
 * They are declared together because only their *ratio* matters. `drawArrowhead`
 * makes a triangle as wide as it is long, so a head is legible as a head only if it
 * clearly out-measures the line it terminates: at 8px on an edge free to clamp to
 * 6px it read as the line getting slightly fatter, and nothing more. Keep the head
 * at roughly 3x the edge's ceiling.
 *
 * An edge's width has to be scaled at all three of these at once. `EDGE_WIDTH` is
 * world-space and only bites in the middle of the zoom range; at the ends the pixel
 * clamps are what you actually see. Scaling one alone just moves where it clamps.
 */
const ARROW_PX = 18;
const EDGE_WIDTH = 1.5; // world units per unit of `1 + log(traversals)`
const EDGE_MIN_PX = 1.5;
const EDGE_MAX_PX = 6;

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
  /** The un-searched tree, drawn before the playhead reaches it. */
  ghostColor: string;
  /** Inline node labels. Ignored by plot mode, which has none. */
  labelColor?: string;
  /** Steps a body takes to fade out. Sigma's equivalent was 400. */
  fadeWindow?: number;
  generation?: number;
};

/** World extent that plot-mode axes are mapped onto. */
const PLOT_SPAN = 1000;

/**
 * The synthetic "step" axis: an event's *index*, not a property on it.
 *
 * Reading it off the event like any other metric yields `undefined -> NaN -> 0`, so
 * every point lands in the same column and the plot collapses to a line. It has to
 * be resolved against the event's position in the trace instead.
 */
export const METRIC_STEP = "step";
const metric = (e: TraceEvent, i: number, property: string): number =>
  property === METRIC_STEP ? i : num(e[property]);

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
  /**
   * The un-searched tree, as its own layer.
   *
   * Separate rather than mixed in, because its opacity then lives in
   * {@link LayerParams} — which is applied when the layer is *composited*, so it
   * re-composites from the tile cache instead of re-rasterizing. That makes ghost
   * opacity a live slider, which a per-body alpha baked into the store could never
   * be: changing it would mean repacking the column and rebuilding the index.
   *
   * Absent in plot mode: a scatter point's position comes from its own event, so
   * there is nothing to draw before that event exists.
   */
  ghost?: SharedComponentStore;
  /** The mode it was built for. */
  mode: GraphMode;
  /**
   * The layer's sizing and label policy — returned *with* the store rather than
   * derived from it later.
   *
   * These two have to agree about what the `size` column means, and when they were
   * authored apart they didn't: the store packed 20 world units while the policy
   * clamped at 20 *pixels* and a test asserted on a third number entirely, so the
   * splat LOD the whole design rests on never once ran. Handing them out together
   * is what stops that recurring — there is now one place that decides.
   */
  params: LayerParams;
  /** Plot mode only. */
  scales?: { x: AxisScale; y: AxisScale };
  /** Content bounds in world space, for fitting the camera. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Bodies packed ahead of the nodes — the ghosts and the edges. Node body `i` is
   * event `i - nodeOffset`, and that identity is the entire hit-test: the renderer
   * reports a clicked *body index*, and this maps it straight back to the event the
   * user clicked, with no second index and no lookup table.
   */
  nodeOffset: number;
  /**
   * Ramp id per pre-node body. An edge takes its child node's event type — that is
   * what makes edges read as belonging to the node they point at rather than as
   * neutral scaffolding — and a recolour has to put that back without re-deriving
   * the edges. 0 marks a ghost.
   */
  preRamp: Uint8Array;
  /**
   * The child event behind each pre-node body (i.e. each edge).
   *
   * A focused view is a set of *steps*, and an edge belongs to the node it points
   * at, so this is what lets a recolour light the edges along a path as well as its
   * nodes — without re-deriving the edge set from the trace.
   */
  preEvent: Int32Array;
};

/** The event a clicked body refers to; `undefined` for a ghost or an edge. */
export const eventOf = (r: GraphStoreResult, body: number): number | undefined =>
  body >= r.nodeOffset ? body - r.nodeOffset : undefined;

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
  ghostColor,
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
  // The un-searched tree: visible from step 0, so the shape of the whole search is
  // there before the playhead reaches it.
  const ghostFill = palette.push(ghostColor) - 1;

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
      px[i] = applyScale(scales!.x, metric(e, i, scales!.x.property));
      py[i] = applyScale(scales!.y, metric(e, i, scales!.y.property));
    } else {
      const l = nodes.get(String(e.id));
      // Rotation swaps the axes on the *positions*, not in dagre — the layout is
      // cached across orientation changes, so rotating must not re-run it.
      //
      // The y negation matters: dagre puts the root at y=0 and grows downward, and
      // sigma rendered y-*up*, so the tree came out root-at-bottom. Canvas is y-down,
      // so reproducing what the view used to look like means flipping it back.
      px[i] = l ? (horizontal ? -l.y : l.x) : 0;
      py[i] = l ? (horizontal ? -l.x : -l.y) : 0;
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

  // ---- Edges.
  //
  // **One edge body per parent claim, not per edge.** Every event that names a `pId`
  // is a claim, and it gets a body — including the ones a later event overrides.
  //
  // That is what makes a re-parent visible. A search that reaches C from A and later
  // finds a better route from B emits two claims; keeping only the final one (which
  // is what the layout is built from) leaves C with *no* edge at all for the whole
  // stretch of the search where its parent really was A. The edge has to be the
  // node's parent **as of the playhead**, not as of the end of the search.
  //
  // The spans do it, with no per-step work. An edge body takes its child's span —
  // `[i, next event on that child)` — so at any step exactly one of a node's claims
  // is alive: the most recent one before the playhead. A re-parent simply swaps
  // which body is showing. (A directed graph wants the opposite: every claim it ever
  // made, all at once. Same bodies, `end = total`.)
  //
  // Sharing the child's span also fixes the colour: same span + same ramp => same
  // bucket => node and edge resolve to the same colour by construction, at every
  // step, rather than the edge freezing at the colour its child had when the edge
  // was born.
  //
  // `edges` (one entry per *distinct* edge) survives only to build the ghosts and to
  // count traversals.
  type Edge = { from: string; to: string; at: number; visits: number; final: boolean };
  const edges = new Map<string, Edge>();
  /** Event indices that get an edge body, in order. */
  const edgeEvents: number[] = [];
  const edgeVisits: number[] = [];

  if (mode !== "plot") {
    // A node's *last* parent. Not a filter on the bodies any more — it only marks
    // which edges the ghost tree draws, since the ghost is the shape dagre laid out
    // and dagre lays out the final tree.
    const finalParent = new Map<string, string>();
    for (const e of events) {
      if (e.pId != null) finalParent.set(String(e.id), String(e.pId));
    }
    for (let i = 0; i < n; i++) {
      const e = events[i]!;
      if (e.pId == null) continue;
      const id = String(e.id);
      const pId = String(e.pId);
      const key = `${id}::${pId}`;
      const existing = edges.get(key);
      const visits = (existing?.visits ?? 0) + 1;
      if (existing) existing.visits = visits;
      else {
        edges.set(key, {
          from: id,
          to: pId,
          at: i,
          visits: 1,
          final: finalParent.get(id) === pId,
        });
      }
      edgeEvents.push(i);
      edgeVisits.push(visits);
    }
  }

  // ---- Pack, in draw order. `queryVisible` returns indices ascending, so body
  // order *is* draw order: edges, then nodes, so a node sits above its own edges.
  //
  // The **ghosts** — the faint outline of the whole search, present from step 0 —
  // are packed into a *separate store* and loaded as their own layer, under this
  // one. That is what lets their opacity be a `LayerParams.alpha`, applied when the
  // layer is composited rather than baked into an `alpha` column: it re-composites
  // straight from the tile cache, so ghost opacity is a live slider. Baked into the
  // store it would be a repack and an index rebuild per drag.
  //
  // A ghost spans `[0, firstStep)` — showing exactly while its real body is not —
  // and there is one per unique node and per edge, not one per event.
  //
  // Plot mode has none: a scatter point's position comes from its own event, so
  // there is nothing to draw before that event exists.
  const nEdge = edgeEvents.length;
  const count = nEdge + n;

  // The event a node is first reached at. An edge runs between laid-out node
  // positions (which in tree/DAG mode never move), and a ghost lives until exactly
  // this step. Built forwards, so iteration order is discovery order.
  const firstOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = String(events[i]!.id);
    if (!firstOf.has(id)) firstOf.set(id, i);
  }

  const alloc = (n: number, points: number): SharedComponentStore => ({
    generation,
    count: n,
    total,
    kind: sab(Uint8Array, 1, n),
    x: sab(Float32Array, 4, n),
    y: sab(Float32Array, 4, n),
    size: sab(Float32Array, 4, n),
    size2: sab(Float32Array, 4, n),
    alpha: sab(Float32Array, 4, n),
    start: sab(Int32Array, 4, n),
    end: sab(Int32Array, 4, n),
    fill: sab(Int32Array, 4, n),
    palette,
    label: sab(Int32Array, 4, n),
    strings: [""],
    ptOff: sab(Int32Array, 4, n + 1),
    pts: sab(Float32Array, 4, points * 4),
    // Only when there are edges to put arrowheads on. An `arrow` column is not
    // free merely by being empty: `screenPad` inflates every tile query by an
    // arrowhead's reach the moment the column exists, and plot mode — which has no
    // paths at all — was paying 32px a side for arrows it cannot draw.
    arrow: points ? sab(Uint8Array, 1, n) : undefined,
    arrowInset: points ? sab(Float32Array, 4, n) : undefined,
    ramp: sab(Uint8Array, 1, n),
    ramps,
  });

  const arrowPacked = ARROW_TRIANGLE << 4; // end only; start = none

  /**
   * Write a 2-point path into `s` at body `b`, running **parent -> child**.
   *
   * The direction is the search's: a parent expands into a child, so that is where
   * the arrow points. (Writing it child-first — which is how the child's own event
   * reads — puts the head on the *parent*, pointing backwards up the tree.)
   *
   * `inset` is the child's world radius, so the head can be backed off far enough to
   * clear the circle that will be painted over this edge. See
   * {@link SharedComponentStore.arrowInset}.
   */
  const edge = (
    s: SharedComponentStore,
    b: number,
    pt: number,
    parent: number,
    child: number,
    width: number,
    start: number,
    end: number,
    inset: number,
  ) => {
    s.kind[b] = KIND_PATH;
    s.pts[pt] = px[parent]!;
    s.pts[pt + 1] = py[parent]!;
    s.pts[pt + 2] = px[child]!;
    s.pts[pt + 3] = py[child]!;
    s.ptOff[b + 1] = (pt + 4) / 2;
    s.size[b] = width;
    // Arrowhead size, in screen pixels. It has to out-measure the line it sits on or
    // it reads as a thickening rather than as a head — the triangle is as wide as it
    // is long, so at 8px against an edge clamped to 6px there was nothing to see.
    s.size2[b] = ARROW_PX;
    s.arrow![b] = arrowPacked;
    s.arrowInset![b] = inset;
    s.alpha[b] = 1;
    s.start[b] = start;
    s.end[b] = end;
    s.fill[b] = ghostFill;
  };

  /**
   * Each event's node radius, in world units. Precomputed because the *edge* bodies
   * need it too — an arrowhead has to know how big the circle it points at will be —
   * and the edges are packed before the nodes.
   */
  const GHOST_RADIUS = 1.4 * NODE_SCALE;
  const nodeSize = new Float32Array(n);
  if (mode !== "plot") {
    const seen = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const id = String(events[i]!.id);
      const v = (seen.get(id) ?? 0) + 1;
      seen.set(id, v);
      nodeSize[i] = (2 + Math.log(v)) * NODE_SCALE;
    }
  }

  // ---- The ghost layer.
  let ghost: SharedComponentStore | undefined;
  if (mode !== "plot" && (edges.size || firstOf.size)) {
    ghost = alloc(edges.size + firstOf.size, edges.size);
    let g = 0;
    let gpt = 0;
    for (const e of edges.values()) {
      // The ghost is the shape the search *will* have, and in a tree that is the
      // final-parent tree — the one dagre laid out. Ghosting the transient claims
      // too would draw scaffolding for edges that never end up existing.
      if (mode === "tree" && !e.final) continue;
      const child = firstOf.get(e.from);
      const parent = firstOf.get(e.to);
      if (child === undefined || parent === undefined) continue;
      edge(ghost, g, gpt, parent, child, EDGE_WIDTH, 0, e.at, GHOST_RADIUS);
      gpt += 4;
      g++;
    }
    for (const i of firstOf.values()) {
      ghost.kind[g] = KIND_CIRCLE;
      ghost.x[g] = px[i]!;
      ghost.y[g] = py[i]!;
      // Smaller than the real thing: a ghost is scaffolding, and should read as
      // behind the search rather than competing with it.
      ghost.size[g] = GHOST_RADIUS;
      ghost.alpha[g] = 1; // the layer's alpha does the fading
      ghost.start[g] = 0;
      ghost.end[g] = i; // gives way exactly as the node is first reached
      ghost.fill[g] = ghostFill;
      ghost.ptOff[g + 1] = gpt / 2;
      g++;
    }
    ghost.count = g;
  }

  // ---- The graph itself.
  const store = alloc(count, nEdge);
  const ramp = store.ramp!;

  let b = 0;
  let pt = 0;
  /** Ramp id per pre-node body, so a recolour can restore an edge's child colour. */
  const preRamp: number[] = [];
  /** Child event per pre-node body, so a recolour can tell which edges are on a path. */
  const preEvent: number[] = [];

  // A directed graph shows every claim at once; a tree shows the current one. The
  // only difference is where the edge body's span ends.
  const allEdges = mode === "directed-graph";

  for (let k = 0; k < edgeEvents.length; k++) {
    const i = edgeEvents[k]!;
    const ev = events[i]!;
    const child = firstOf.get(String(ev.id));
    const parent = firstOf.get(String(ev.pId));
    if (child === undefined || parent === undefined) continue;
    // The child's span, exactly — so this body shows precisely while the child's
    // does, and the child's *next* event (a revisit, or a re-parent) hands over to
    // the body packed for it.
    // Line width in world units; the layer clamps it into a pixel range.
    edge(
      store,
      b,
      pt,
      parent,
      child,
      EDGE_WIDTH * (1 + Math.log(edgeVisits[k]!)),
      i,
      allEdges ? total : until[i]!,
      nodeSize[i]!,
    );
    pt += 4;
    // And the child's ramp. Same span + same ramp => same bucket => same colour,
    // for free, at every step.
    const r = rampOf.get(String(ev.type ?? "")) ?? 0;
    store.fill[b] = edgeFill;
    ramp[b] = r;
    preRamp[b] = r;
    preEvent[b] = i;
    b++;
  }
  // Node bodies start here, which is what makes a clicked body index invertible
  // back to an event (see `eventOf`).
  const nodeOffset = b;

  const strings = store.strings;
  const stringOf = new Map<string, number>();
  // Plot markers are uniform: in plot mode a body is an *event*, not a node, so
  // growing the k-th point of a node by how often that node has been seen sizes a
  // point by something that isn't a property of the point. A tree's circle *is* the
  // node, so there it means something.
  const marker = plotMarkerPx(n);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const id = String(e.id);

    const X = px[i]!;
    const Y = py[i]!;
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Y < minY) minY = Y;
    if (Y > maxY) maxY = Y;

    store.kind[b] = KIND_CIRCLE;
    store.x[b] = X;
    store.y[b] = Y;
    // The same `nodeSize` the edge bodies backed their arrowheads off by — read from
    // one array rather than recomputed here, so the circle and the head that has to
    // clear it cannot drift apart.
    //
    // In tree/DAG this doubles as the label grid's importance, so a much-visited node
    // keeps its label when a quiet neighbour loses it.
    store.size[b] = persistent ? marker : nodeSize[i]!;
    store.alpha[b] = 1;
    store.start[b] = i;
    store.end[b] = until[i]!;
    ramp[b] = rampOf.get(String(e.type ?? "")) ?? 0;
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
    ghost,
    mode,
    params: layerParams(mode, marker, labelColor),
    scales,
    nodeOffset,
    preRamp: Uint8Array.from(preRamp.slice(0, nodeOffset)),
    preEvent: Int32Array.from(preEvent.slice(0, nodeOffset)),
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
  for (let i = 0; i < events.length; i++) {
    const v = metric(events[i]!, i, property);
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
 * These live in {@link LayerParams} rather than in the store so they can change
 * without a rebuild: node size, edge width and label size are all live sliders, and
 * dragging one re-rasterizes but never repacks a column or rebuilds the spatial
 * index. But they are *derived here*, next to the packing they have to agree with —
 * a policy that reads the `size` column differently from the code that wrote it is
 * exactly the bug this replaces.
 */
function layerParams(mode: GraphMode, marker: number, labelColor = "#888888"): LayerParams {
  if (mode === "plot") {
    return {
      sizing: {
        // Screen-space: a scatter point is a *marker*, and a marker does not grow
        // when you zoom — you zoom a plot to separate points, not to enlarge them.
        // `max` at the splat radius makes the LOD structural rather than incidental:
        // `drawBody` cannot reach the ellipse branch from here, so a fitted 717k
        // cloud is 717k `fillRect`s no matter where the camera is. (See
        // `plotMarkerPx` for why world-space sizing was catastrophic.)
        //
        // It also keeps each point's *indexed box* small — `bodyBounds` reads the
        // same column — so a point lands in one tile instead of thirteen.
        circle: { screen: true, min: 1, max: Math.max(marker, 2) },
      },
      // No labels. A plot body is an event, so a node visited 30 times contributes
      // 30 points all bearing the same id — noise at any zoom, and not cheap noise:
      // a label policy inflates every tile query by its own widest possible label
      // (~196px a side here), which on this store is a ~4x overdraw, plus a grid
      // pass and a set lookup per body per frame.
      //
      // The `label` *column* stays populated regardless: the hit-test reads it to
      // name a clicked point.
    };
  }
  return {
    sizing: {
      // World-space, so nodes spread apart as you zoom in — but clamped, because a
      // node that keeps growing becomes a blob and one that keeps shrinking
      // vanishes. Floored at 3 rather than 1 because a tree draws one circle per
      // *unique id* (25k on the trace where the plot has 717k points), so ellipses
      // are affordable and legibility wins: at 1px a fitted tree is a smear of dots,
      // which is what "nodes are way too small" looked like.
      circle: { min: 3, max: 24 },
      path: { min: EDGE_MIN_PX, max: EDGE_MAX_PX },
    },
    label: {
      size: 12,
      color: labelColor,
      offset: 4,
      // One label per cell. Sized so a 512px tile holds ~8x16 of them.
      grid: { width: 64, height: 32 },
    },
  };
}
