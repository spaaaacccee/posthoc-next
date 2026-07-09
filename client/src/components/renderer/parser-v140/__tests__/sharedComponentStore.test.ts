import { describe, expect, it } from "vitest";
import { TraceEvent } from "protocol";
import type { ComponentEntry } from "renderer";
import { SingleFrame } from "../ParseTraceSlaveWorker";
import { buildSharedComponentStore } from "../sharedComponentStore";

/**
 * Isolates the packing + span logic from view compilation by handing
 * `buildSharedComponentStore` a hand-crafted per-step generator. Covers all
 * three lifespan kinds and asserts the spans reproduce today's visibility model.
 */

const entry = (component: Record<string, unknown>): ComponentEntry =>
  ({ component, meta: { source: "trace" } }) as unknown as ComponentEntry;

type Frame = {
  event: Partial<TraceEvent>;
  persistent?: Record<string, unknown>[];
  transient?: Record<string, unknown>[];
  special?: Record<string, unknown>[];
};

// A = persistent@0, S1 = special@1 (cleared@3), B = persistent@1,
// T = own-transient@2, C = persistent@3, S2 = special@4 (never cleared).
const rect = (x: number, fill: string, extra: Record<string, unknown> = {}) =>
  ({ $: "rect", x, y: 0, width: 1, height: 1, fill, ...extra }) as Record<string, unknown>;

const frames: Frame[] = [
  { event: { id: 0, type: "source" }, persistent: [rect(10, "red")] }, // A
  {
    event: { id: 1, type: "expanding" },
    persistent: [rect(11, "red")], // B (fill dedups with A)
    special: [rect(21, "blue", { clear: "visited" })], // S1
  },
  { event: { id: 2, type: "expanding" }, transient: [rect(32, "green", { clear: true })] }, // T
  { event: { id: 1, type: "visited" }, persistent: [rect(13, "red")] }, // clears S1; C
  { event: { id: 4, type: "expanding" }, special: [rect(24, "blue", { clear: "done" })] }, // S2
  { event: { id: 5, type: "x" } },
];

const gen = (i: number): SingleFrame =>
  ({
    event: frames[i]!.event as TraceEvent,
    components: {
      persistent: (frames[i]!.persistent ?? []).map(entry),
      transient: (frames[i]!.transient ?? []).map(entry),
      special: (frames[i]!.special ?? []).map(entry),
    },
  }) as SingleFrame;

const total = frames.length;

describe("buildSharedComponentStore spans", () => {
  const store = buildSharedComponentStore({ gen, total });

  it("packs one body per included component in emit order", () => {
    // A0, B1, S1=2, T3, C4, S2=5
    expect(store.count).toBe(6);
    expect(Array.from(store.kind)).toEqual([0, 0, 0, 0, 0, 0]); // all rect
    expect(Array.from(store.x)).toEqual([10, 11, 21, 32, 13, 24]);
  });

  it("stamps contiguous [start,end) spans for all three lifespan kinds", () => {
    // persistent -> [birth,total); own-transient -> [i,i+1); special -> [emit,clear)
    expect(Array.from(store.start)).toEqual([0, 1, 1, 2, 3, 4]);
    expect(Array.from(store.end)).toEqual([total, total, 3, 3, total, total]);
  });

  it("dedups the fill palette", () => {
    expect(store.palette).toEqual(["", "red", "blue", "green"]);
    expect(Array.from(store.fill)).toEqual([1, 1, 2, 3, 1, 2]); // A,B=red S1,S2=blue T=green
  });

  it("reproduces per-step visibility exactly (start<=s<end)", () => {
    const visibleAt = (s: number) => {
      const set = new Set<number>();
      for (let i = 0; i < store.count; i++) {
        if (store.start[i]! <= s && s < store.end[i]!) set.add(i);
      }
      return set;
    };
    // A0 B1 S1=2 T3 C4 S2=5
    expect(visibleAt(0)).toEqual(new Set([0]));
    expect(visibleAt(1)).toEqual(new Set([0, 1, 2]));
    expect(visibleAt(2)).toEqual(new Set([0, 1, 2, 3]));
    expect(visibleAt(3)).toEqual(new Set([0, 1, 4])); // S1 cleared; T ended; C born
    expect(visibleAt(4)).toEqual(new Set([0, 1, 4, 5]));
    expect(visibleAt(5)).toEqual(new Set([0, 1, 4, 5]));
  });
});

describe("buildSharedComponentStore prefix + include", () => {
  it("builds a streaming-preview prefix and leaves open specials visible to total", () => {
    const store = buildSharedComponentStore({ gen, total, prefixEnd: 2 });
    // Only A0, B1, S1=2 emitted; S1 not yet cleared within the prefix -> end=total.
    expect(store.count).toBe(3);
    expect(Array.from(store.end)).toEqual([total, total, total]);
  });

  it("skips kinds outside `include`", () => {
    const store = buildSharedComponentStore({
      gen,
      total,
      include: new Set(["circle"]), // no rects packed
    });
    expect(store.count).toBe(0);
  });

  it("backs every column with a SharedArrayBuffer", () => {
    const store = buildSharedComponentStore({ gen, total });
    expect(store.x.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(store.kind.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(store.start.buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});
