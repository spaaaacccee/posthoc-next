import { describe, expect, it } from "vitest";
import { EventContext, TraceEvent } from "protocol";
import { Trace } from "protocol/Trace-v140";
import { createFrameGenerator } from "../ParseTraceSlaveWorker";
import { buildSharedEventStore, makeLazyEvents, SharedEventStore } from "../sharedEventStore";

const events: TraceEvent[] = [
  { id: 0, type: "a", g: 10 } as TraceEvent,
  { id: 1, pId: 0, type: "b", g: 20 } as TraceEvent,
  { id: 2, pId: 1, type: "c", g: 30 } as TraceEvent,
  { id: 3, pId: 99, type: "d", g: 40 } as TraceEvent, // parent id never seen -> events[0]
  { id: 1, pId: 0, type: "e", g: 50 } as TraceEvent, // id 1 reused
];

const context = {
  theme: { foreground: "#000", background: "#fff", accent: "#f00" },
  color: {},
} as unknown as EventContext;

describe("SharedEventStore", () => {
  it("round-trips every event through the shared blob", async () => {
    const store = new SharedEventStore(await buildSharedEventStore(events));
    expect(store.total).toBe(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(store.get(i)).toEqual(events[i]);
    }
    expect(store.get(-1)).toBeUndefined();
    expect(store.get(events.length)).toBeUndefined();
  });

  it("precomputes parent steps matching groupBy/findLast semantics (incl. id 0)", async () => {
    const store = new SharedEventStore(await buildSharedEventStore(events));
    // [no parent, id0@0, id1@1, unseen->0, id0@0]
    expect(Array.from(store.parents)).toEqual([-1, 0, 1, 0, 0]);
  });
});

describe("makeLazyEvents", () => {
  it("behaves like an array (index, length, iteration, methods)", async () => {
    const store = new SharedEventStore(await buildSharedEventStore(events));
    const lazy = makeLazyEvents(store);
    expect(lazy.length).toBe(5);
    expect(lazy[2]!.g).toBe(30);
    expect(lazy.map((e) => e.id)).toEqual([0, 1, 2, 3, 1]);
    expect(lazy.filter((e) => e.type === "b")).toHaveLength(1);
    expect(lazy.find((e) => e.id === 2)?.g).toBe(30);
    expect([...lazy]).toHaveLength(5);
  });
});

describe("createFrameGenerator SAB vs plain equivalence", () => {
  const trace: Trace = {
    version: "1.4.0",
    events,
    views: {
      main: [
        {
          $: "node",
          pg: "${{ parent ? parent.g : -1 }}",
          n: "${{ events.length }}",
          s: "${{ step }}",
        },
      ],
    },
  } as unknown as Trace;

  const read = (frame: ReturnType<ReturnType<typeof createFrameGenerator>>) => {
    const c = frame.components.persistent![0]!.component as Record<string, unknown>;
    return { event: frame.event, pg: c.pg, n: c.n, s: c.s };
  };

  it("produces identical frames from the shared store as from trace.events", async () => {
    const store = new SharedEventStore(await buildSharedEventStore(events));
    const plain = createFrameGenerator({ trace, context });
    const shared = createFrameGenerator({
      trace: { ...trace, events: undefined },
      context,
      events: makeLazyEvents(store),
      parents: store.parents,
    });
    for (let i = 0; i < events.length; i++) {
      expect(read(shared(i))).toEqual(read(plain(i)));
    }
    // Sanity: parent-derived value actually resolves through both paths.
    expect(read(shared(0)).pg).toBe(-1);
    expect(read(shared(1)).pg).toBe(10);
    expect(read(shared(2)).n).toBe(5);
  });
});
