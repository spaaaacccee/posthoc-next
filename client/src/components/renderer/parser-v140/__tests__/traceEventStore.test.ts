import { describe, expect, it } from "vitest";
import { TraceEvent } from "protocol";
import { SharedEventStore } from "../sharedEventStore";
import {
  disposeSharedEventStore,
  getSharedEventStore,
  peekSharedEventStore,
} from "../traceEventStore";

const events: TraceEvent[] = [
  { id: 0, type: "a" } as TraceEvent,
  { id: 1, pId: 0, type: "b" } as TraceEvent,
];

describe("traceEventStore cache", () => {
  it("builds once per key and returns the same handles", async () => {
    const a = getSharedEventStore("k1", events);
    const b = getSharedEventStore("k1", events);
    expect(a).toBe(b); // same cached promise, no rebuild
    const store = new SharedEventStore(await a);
    expect(store.total).toBe(2);
    expect(store.get(1)).toEqual(events[1]);
    disposeSharedEventStore("k1");
  });

  it("peek does not trigger a build", async () => {
    expect(peekSharedEventStore("k2")).toBeUndefined();
    const p = getSharedEventStore("k2", events);
    expect(peekSharedEventStore("k2")).toBe(p);
    disposeSharedEventStore("k2");
    expect(peekSharedEventStore("k2")).toBeUndefined();
  });

  it("rebuilds after disposal", async () => {
    const a = getSharedEventStore("k3", events);
    await a;
    disposeSharedEventStore("k3");
    const b = getSharedEventStore("k3", events);
    expect(b).not.toBe(a);
    await b;
    disposeSharedEventStore("k3");
  });
});
