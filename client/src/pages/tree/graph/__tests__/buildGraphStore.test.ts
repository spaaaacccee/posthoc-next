import { describe, expect, it } from "vitest";
import { shadeOf } from "renderer";
import type { Trace } from "protocol/Trace-v140";
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
  labelColor: "#000000",
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

/** Bodies of a kind, as plain objects. 1 = circle, 2 = path. */
const bodiesOf = (r: ReturnType<typeof buildGraphStore>, kind: number) => {
  const { store } = r;
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
      arrow: store.arrow![i],
    });
  }
  return out;
};

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

  it("runs each edge between its endpoints' laid-out positions", () => {
    const { store } = build();
    // First edge is b -> a: (10,100) -> (0,0).
    expect([...store.pts.slice(0, 4)]).toEqual([10, 100, 0, 0]);
  });

  it("keeps only the final parent in tree mode, but every parent in a DAG", () => {
    const reparented: Trace = {
      version: "1.4.0",
      events: [
        { type: "generating", id: "a", pId: null },
        { type: "generating", id: "b", pId: "a" },
        { type: "generating", id: "c", pId: null },
        { type: "generating", id: "b", pId: "c" }, // b re-parented onto c
      ],
    };
    const l: NodeLayout[] = [
      { label: "a", x: 0, y: 0, size: 1 },
      { label: "b", x: 10, y: 10, size: 1 },
      { label: "c", x: 20, y: 20, size: 1 },
    ];
    const tree = build({ trace: reparented, layout: l, mode: "tree" });
    expect(bodiesOf(tree, 2)).toHaveLength(1); // only b -> c survives

    const dag = build({ trace: reparented, layout: l, mode: "directed-graph" });
    expect(bodiesOf(dag, 2)).toHaveLength(2); // b -> a and b -> c
  });

  it("thickens an edge with its traversal count", () => {
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
    const [edge] = bodiesOf(build({ trace: busy, layout: l }), 2);
    expect(edge!.size).toBeCloseTo(1 + Math.log(3));
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
    const { store } = build({ fadeWindow: 100 });
    const a = 2; // first node body (2 edges packed ahead of it)
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
    const { store } = build({ fadeWindow: 100 });
    const a = 2;
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
    expect(r.store.count).toBe(6); // 2 edges + 4 nodes, all at the origin
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
    // after edges, so subtracting the edge count recovers the event with no lookup
    // table and no second index.
    const r = build(); // 2 edges, then 4 nodes
    expect(r.edgeCount).toBe(2);
    expect(eventOf(r, 2)).toBe(0);
    expect(eventOf(r, 5)).toBe(3);
  });

  it("reports an edge click as no event", () => {
    const r = build();
    expect(eventOf(r, 0)).toBeUndefined();
    expect(eventOf(r, 1)).toBeUndefined();
  });
});
