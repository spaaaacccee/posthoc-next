import { describe, expect, it } from "vitest";
import { shadeOf } from "renderer";
import type { Trace } from "protocol/Trace-v140";
import type { SharedComponentStore } from "renderer";
import {
  applyScale,
  buildGraphStore,
  eventOf,
  invertScale,
  type NodeLayout,
} from "../buildGraphStore";

const colors = { generating: "#0000ff", expanding: "#ff0000", "": "#888888" };
const base = {
  colors,
  background: "#ffffff",
  edgeColor: "#cccccc",
  ghostColor: "#eeeeee",
} as const;

/** a -> b -> c, with `a` revisited at the end. */
const trace = (): Trace => ({
  version: "1.4.0",
  events: [
    { type: "generating", id: "a", pId: null, g: 0, f: 10 },
    { type: "generating", id: "b", pId: "a", g: 1, f: 11 },
    { type: "expanding", id: "c", pId: "b", g: 2, f: 12 },
    { type: "expanding", id: "a", pId: null, g: 3, f: 13 },
  ],
});

const layout = (): NodeLayout[] => [
  { label: "a", x: 0, y: 0, size: 1 },
  { label: "b", x: 10, y: 100, size: 1 },
  { label: "c", x: 20, y: 200, size: 1 },
];

const build = (o: Partial<Parameters<typeof buildGraphStore>[0]> = {}) =>
  buildGraphStore({ trace: trace(), mode: "tree", layout: layout(), ...base, ...o });

/** Bodies of a kind, from a store. 1 = circle, 2 = path. */
const bodiesIn = (store: SharedComponentStore, kind: number) => {
  const out = [];
  for (let i = 0; i < store.count; i++) {
    if (store.kind[i] !== kind) continue;
    out.push({
      i,
      x: store.x[i],
      y: store.y[i],
      size: store.size[i],
      start: store.start[i],
      end: store.end[i],
      ramp: store.ramp![i],
      label: store.strings[store.label[i]!],
      // Absent when the store has no paths to put arrowheads on — plot mode. The
      // column is not free merely by being empty: its presence alone inflates every
      // tile query by an arrowhead's reach (see `screenPad`).
      arrow: store.arrow?.[i] ?? 0,
    });
  }
  return out;
};

/** Bodies of the graph proper. The ghosts are their own store now. */
const bodiesOf = (r: ReturnType<typeof buildGraphStore>, kind: number) => bodiesIn(r.store, kind);

describe("buildGraphStore: bodies", () => {
  it("emits one node body per event, not per node", () => {
    // `a` appears at steps 0 and 3, so it is two bodies.
    const nodes = bodiesOf(build(), 1);
    expect(nodes).toHaveLength(4);
    expect(nodes.map((n) => n.label)).toEqual(["a", "b", "c", "a"]);
  });

  it("gives a revisited node a fresh span, so its ramp restarts", () => {
    // This is the whole reason for a body per event. `a`'s first body dies exactly
    // when its second is born, so only ever one circle is drawn — but the second
    // has its own `start`, so the revisit re-highlights. Sigma got this by
    // recolouring the node in place, an O(visible) main-thread pass every step.
    const nodes = bodiesOf(build(), 1).filter((n) => n.label === "a");
    expect(nodes.map((n) => [n.start, n.end])).toEqual([
      [0, 3], // born at 0, dies when the revisit lands
      [3, 4], // born at 3, lives to the end
    ]);
  });

  it("keeps a node's bodies disjoint, so exactly one is visible at a time", () => {
    const nodes = bodiesOf(build(), 1).filter((n) => n.label === "a");
    for (const step of [0, 1, 2, 3]) {
      const live = nodes.filter((n) => n.start! <= step && step < n.end!);
      expect(live).toHaveLength(1);
    }
  });

  it("sizes a node by its visit count, which is also its label priority", () => {
    const nodes = bodiesOf(build(), 1).filter((n) => n.label === "a");
    expect(nodes[1]!.size).toBeGreaterThan(nodes[0]!.size);
  });

  it("packs edges before nodes, so body order is draw order", () => {
    // `queryVisible` returns indices ascending, so edges must be packed first or
    // they would paint over the nodes.
    const r = build();
    const edges = bodiesOf(r, 2);
    const nodes = bodiesOf(r, 1);
    expect(Math.max(...edges.map((e) => e.i))).toBeLessThan(Math.min(...nodes.map((n) => n.i)));
  });
});

describe("buildGraphStore: edges", () => {
  it("draws an arrowhead at the child end of each edge", () => {
    const edges = bodiesOf(build(), 2);
    expect(edges).toHaveLength(2); // b->a, c->b
    // Triangle (shape 1) at the end, none at the start.
    for (const e of edges) expect(e.arrow).toBe(1 << 4);
  });

  it("runs each edge from the parent to the child, not the other way", () => {
    // The direction is the *search's*: a parent expands into a child, so that is
    // where the head points. Writing it child-first — which is how the child's own
    // event reads — aims the arrow back up the tree at the parent.
    const r = build();
    // y is negated: dagre grows downward, the view grows upward.
    const [e] = bodiesOf(r, 2);
    const from = r.store.ptOff[e!.i]! * 2;
    // Edge for event 1 (`b`, parent `a`): starts at a (0, -0), ends at b (10, -100).
    expect(Array.from(r.store.pts.slice(from, from + 4))).toEqual([0, -0, 10, -100]);
  });

  it("backs each arrowhead off by the radius of the node it points at", () => {
    // Otherwise the head is drawn at the terminal vertex — a node's *centre* — and
    // nodes are packed after edges, so they paint straight over it. The head has to
    // clear the circle, and the circle's drawn radius is a clamped screen quantity,
    // so the inset has to be the target's size rather than a distance.
    const r = build();
    const [edge] = bodiesOf(r, 2); // event 1: `b`, first visit
    const b = bodiesOf(r, 1).find((x) => x.label === "b")!;
    expect(r.store.arrowInset![edge!.i]).toBeCloseTo(b.size!, 5);
    expect(r.store.arrowInset![edge!.i]).toBeGreaterThan(0);
  });

  const reparented = (): Trace => ({
    version: "1.4.0",
    events: [
      { type: "generating", id: "a", pId: null },
      { type: "generating", id: "b", pId: "a" },
      { type: "generating", id: "c", pId: null },
      { type: "generating", id: "b", pId: "c" }, // b re-parented onto c
    ],
  });
  const reLayout = (): NodeLayout[] => [
    { label: "a", x: 0, y: 0, size: 1 },
    { label: "b", x: 10, y: 10, size: 1 },
    { label: "c", x: 20, y: 20, size: 1 },
  ];

  it("shows a node's parent as of the playhead, not its final parent", () => {
    // The search reaches `b` from `a`, then re-parents it onto `c`. Until that second
    // event `b`'s parent really *is* `a`, and the tree has to say so. Keeping only the
    // final parent — which is what the layout is built from — leaves `b` with no edge
    // at all for the entire stretch of the search where it had one.
    const tree = build({ trace: reparented(), layout: reLayout(), mode: "tree" });
    const es = bodiesOf(tree, 2);
    expect(es).toHaveLength(2);
    // Disjoint spans, so exactly one is alive at a time: the latest claim before the
    // playhead. No per-step work — the re-parent is just a handover between bodies.
    expect(es.map((e) => [e.start, e.end])).toEqual([
      [1, 3], // b -> a, until b's next event
      [3, 4], // b -> c, from the re-parent onward
    ]);
  });

  it("shows every parent a node ever had, all at once, in a DAG", () => {
    const dag = build({ trace: reparented(), layout: reLayout(), mode: "directed-graph" });
    // Same bodies as the tree; they just never expire. That *is* "show all edges".
    expect(bodiesOf(dag, 2).map((e) => [e.start, e.end])).toEqual([
      [1, 4],
      [3, 4],
    ]);
  });

  it("ghosts only the final tree, which is the one dagre laid out", () => {
    // The ghost is the shape the search *will* have. Ghosting the transient claims
    // too would scaffold edges that never end up existing.
    const tree = build({ trace: reparented(), layout: reLayout(), mode: "tree" });
    expect(bodiesIn(tree.ghost!, 2)).toHaveLength(1); // b -> c only
  });

  it("thickens an edge as it is re-traversed", () => {
    const busy: Trace = {
      version: "1.4.0",
      events: [
        { type: "generating", id: "a", pId: null },
        { type: "generating", id: "b", pId: "a" },
        { type: "generating", id: "b", pId: "a" },
        { type: "generating", id: "b", pId: "a" },
      ],
    };
    const l: NodeLayout[] = [
      { label: "a", x: 0, y: 0, size: 1 },
      { label: "b", x: 10, y: 10, size: 1 },
    ];
    // One body per traversal, each thicker than the last — and their spans are
    // disjoint, so only one is ever drawn. The edge thickens *live* as the search
    // re-traverses it.
    const es = bodiesOf(build({ trace: busy, layout: l }), 2);
    expect(es).toHaveLength(3);
    // `size` is a Float32Array, so compare with tolerance.
    // Monotonic in traversal count, and growing sub-linearly (log). Asserted as a
    // shape rather than against a restated formula — the widths are scaled by a
    // constant that is free to change, and a test that hardcodes it only ever fails
    // for the wrong reason.
    const sizes = es.map((e) => e.size!);
    expect(sizes).toHaveLength(3);
    for (const [k, s] of sizes.entries()) {
      if (k) expect(s).toBeGreaterThan(sizes[k - 1]!);
    }
    expect(sizes[2]! - sizes[1]!).toBeLessThan(sizes[1]! - sizes[0]!);
  });

  it("gives an edge its child's span and ramp, so the two never drift apart", () => {
    // The bug this guards: an edge packed once, when it was created, freezes at the
    // colour its child had *then*. Revisit the child and it re-brightens while its
    // edge stays stale. Sharing the span and the ramp makes them resolve to the same
    // colour by construction, at every step, rather than by coincidence.
    const revisit: Trace = {
      version: "1.4.0",
      events: [
        { type: "generating", id: "a", pId: null },
        { type: "generating", id: "b", pId: "a" }, // b born, generating
        { type: "expanding", id: "b", pId: "a" }, // b revisited, now expanding
      ],
    };
    const l: NodeLayout[] = [
      { label: "a", x: 0, y: 0, size: 1 },
      { label: "b", x: 10, y: 10, size: 1 },
    ];
    const r = build({ trace: revisit, layout: l });
    const edges = bodiesOf(r, 2);
    const nodesB = bodiesOf(r, 1).filter((x) => x.label === "b");

    expect(edges).toHaveLength(2);
    expect(nodesB).toHaveLength(2);
    for (let k = 0; k < 2; k++) {
      expect(edges[k]!.start).toBe(nodesB[k]!.start);
      expect(edges[k]!.end).toBe(nodesB[k]!.end);
      expect(edges[k]!.ramp).toBe(nodesB[k]!.ramp);
    }
    // And the ramp actually changed when the event type did.
    expect(edges[0]!.ramp).not.toBe(edges[1]!.ramp);
  });

  it("emits no edges in plot mode", () => {
    expect(bodiesOf(build({ mode: "plot" }), 2)).toHaveLength(0);
  });
});

describe("buildGraphStore: colour ramps", () => {
  it("gives each event type its own ramp, fading towards the background", () => {
    const { store } = build();
    expect(store.ramps).toHaveLength(2); // generating, expanding
    const nodes = bodiesOf(build(), 1);
    // `a`@0 and `b`@1 are generating; `c`@2 and `a`@3 are expanding.
    expect(nodes[0]!.ramp).toBe(nodes[1]!.ramp);
    expect(nodes[2]!.ramp).toBe(nodes[3]!.ramp);
    expect(nodes[0]!.ramp).not.toBe(nodes[2]!.ramp);
  });

  it("walks a body down its ramp as the playhead leaves it behind", () => {
    const r0 = build({ fadeWindow: 100 });
    const { store } = r0;
    const a = r0.nodeOffset;
    expect(store.kind[a]).toBe(1);
    const fresh = shadeOf(store, a, 0);
    const aging = shadeOf(store, a, 50);
    const faded = shadeOf(store, a, 99);
    expect(aging).toBeGreaterThan(fresh);
    expect(faded).toBeGreaterThan(aging);
  });

  it("saturates rather than fading to nothing", () => {
    // A fully-faded node must stay visible, or the graph erases itself behind the
    // playhead. The ramp stops short of the background, and holds there.
    const r0 = build({ fadeWindow: 100 });
    const { store } = r0;
    const a = r0.nodeOffset;
    expect(shadeOf(store, a, 100)).toBe(shadeOf(store, a, 100_000));
    const last = store.palette[shadeOf(store, a, 100_000)]!;
    expect(last).not.toBe("#ffffff");
  });
});

describe("buildGraphStore: plot mode", () => {
  it("places a node per event from its own properties, not from a layout", () => {
    // The property that positions a node can change between its events, so the two
    // bodies for `a` land in different places. Tree mode's positions never move —
    // and the code needs no branch for that, because it falls out of the same model.
    const nodes = bodiesOf(build({ mode: "plot", x: "g", y: "f" }), 1);
    expect(nodes[0]!.x).not.toBe(nodes[3]!.x); // a@g=0 vs a@g=3
  });

  it("maps the data range onto the world span", () => {
    const r = build({ mode: "plot", x: "g", y: "f" });
    expect(r.scales!.x).toMatchObject({ property: "g", min: 0, max: 3, log: false });
    const nodes = bodiesOf(r, 1);
    expect(nodes[0]!.x).toBe(0); // g=0 -> world 0
    expect(nodes[3]!.x).toBe(1000); // g=3 -> world span
  });

  it("round-trips a world coordinate back to a data value, for the axis ticks", () => {
    // The axis overlay inverts this to place its labels. The renderer never learns
    // that a log scale exists — the scale is applied here, at pack time.
    for (const log of [false, true]) {
      const r = build({ mode: "plot", x: "g", y: "f", log });
      const s = r.scales!.x;
      for (const v of [0, 1, 2, 3]) {
        expect(invertScale(s, applyScale(s, v))).toBeCloseTo(v, 4);
      }
    }
  });
});

describe("buildGraphStore: degenerate input", () => {
  it("handles an empty trace", () => {
    const r = buildGraphStore({ mode: "tree", layout: [], ...base });
    expect(r.store.count).toBe(0);
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  });

  it("survives a missing layout by collapsing everything onto the origin", () => {
    // Happens only transiently, while dagre is still running. Everything packs at
    // (0, 0): edges become zero-length, which the draw path already guards against
    // (it needs a direction to orient an arrowhead). The point is that it does not
    // throw and does not emit NaN positions into the spatial index, which would
    // poison the Flatbush build.
    const r = build({ layout: [] });
    expect(r.store.count).toBe(6); // 2 edge bodies + 4 node bodies, all at the origin
    for (let i = 0; i < r.store.count; i++) {
      expect(r.store.x[i]).toBe(0);
      expect(r.store.y[i]).toBe(0);
    }
  });

  it("does not divide by zero when an axis is constant", () => {
    const flat: Trace = {
      version: "1.4.0",
      events: [
        { type: "generating", id: "a", g: 5 },
        { type: "generating", id: "b", g: 5 },
      ],
    };
    const nodes = bodiesOf(build({ trace: flat, mode: "plot", x: "g", y: "g" }), 1);
    expect(nodes.every((n) => Number.isFinite(n.x!))).toBe(true);
  });
});

describe("eventOf", () => {
  it("maps a clicked body index straight back to its event", () => {
    // The whole hit-test. The renderer hands back a body index; nodes are packed
    // last, so subtracting `nodeOffset` recovers the event with no lookup table and
    // no second index.
    const r = build();
    expect(eventOf(r, r.nodeOffset)).toBe(0);
    expect(eventOf(r, r.nodeOffset + 3)).toBe(3);
  });

  it("reports an edge click as no event", () => {
    const r = build();
    expect(eventOf(r, 0)).toBeUndefined();
    expect(eventOf(r, r.nodeOffset - 1)).toBeUndefined();
  });
});

describe("buildGraphStore: the ghost tree", () => {
  it("is its own store, so its opacity can be a layer param", () => {
    // Separate rather than mixed in: `LayerParams.alpha` is applied at *composite*
    // time, so a ghost-opacity slider re-composites from the tile cache. Baked into
    // the store's `alpha` column it would be a repack plus an index rebuild per drag.
    const r = build(); // ids a, b, c; edges b->a, c->b
    expect(r.ghost).toBeDefined();
    expect(r.ghost!.count).toBe(3 + 2); // 3 ghost nodes + 2 ghost edges
    // And the graph proper holds no ghosts.
    expect(r.store.count).toBe(2 + 4); // 2 edge bodies + 4 node bodies
  });

  it("gives way exactly as the search arrives", () => {
    // One ghost per *unique node*, not per event, spanning [0, firstStep) — so it is
    // showing precisely while the real body is not.
    const r = build();
    const ghostNodes = bodiesIn(r.ghost!, 1).map((g) => [g.start, g.end]);
    expect(ghostNodes).toEqual([
      [0, 0], // a: first reached at step 0, so its ghost never shows
      [0, 1], // b
      [0, 2], // c
    ]);
  });

  it("has no ghosts in plot mode", () => {
    // A scatter point's position comes from its own event, so there is nothing to
    // draw before that event exists.
    const r = build({ mode: "plot" });
    expect(r.ghost).toBeUndefined();
    expect(r.nodeOffset).toBe(0);
  });
});

describe("buildGraphStore: the step axis", () => {
  it("resolves `step` as the event index, not as a property", () => {
    // `step` is synthetic. Read off the event like any other metric it is
    // `undefined -> NaN -> 0`, and every point collapses into one column.
    const r = build({ mode: "plot", x: "step", y: "g" });
    expect(r.scales!.x).toMatchObject({ min: 0, max: 3 });
    // Spread evenly across the world span, one column per step — not all on zero.
    const xs = bodiesOf(r, 1).map((nd) => nd.x!);
    for (const [k, x] of xs.entries()) expect(x).toBeCloseTo((k / 3) * 1000, 3);
  });
});
