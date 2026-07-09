import { describe, expect, it } from "vitest";
import type { SharedComponentStore } from "renderer";
import { bodyBounds, buildIndex, openIndex } from "../columnarIndex";

const f32 = (a: number[]) => {
  const t = new Float32Array(new SharedArrayBuffer(a.length * 4));
  t.set(a);
  return t;
};
const i32 = (a: number[]) => {
  const t = new Int32Array(new SharedArrayBuffer(a.length * 4));
  t.set(a);
  return t;
};

// rect@(0,0,10x10), circle@(100,100,r5), rect@(50,50,10x10)
function makeStore(): SharedComponentStore {
  const n = 3;
  const kind = new Uint8Array(new SharedArrayBuffer(n));
  kind.set([0, 1, 0]);
  return {
    generation: 1,
    count: n,
    total: 10,
    kind,
    x: f32([0, 100, 50]),
    y: f32([0, 100, 50]),
    size: f32([10, 5, 10]),
    size2: f32([10, 0, 10]),
    alpha: f32([1, 1, 1]),
    start: i32([0, 0, 0]),
    end: i32([10, 10, 10]),
    fill: i32([1, 1, 1]),
    palette: ["", "red"],
    label: i32([0, 0, 0]),
    strings: [""],
    ptOff: i32(new Array(n + 1).fill(0)),
    pts: f32([]),
  };
}

const sortNum = (a: number[]) => a.slice().sort((x, y) => x - y);

describe("columnarIndex", () => {
  const store = makeStore();

  it("computes bounding boxes per kind matching primitives.test", () => {
    expect(bodyBounds(store, 0)).toEqual([0, 0, 10, 10]); // rect
    expect(bodyBounds(store, 1)).toEqual([95, 95, 105, 105]); // circle
    expect(bodyBounds(store, 2)).toEqual([50, 50, 60, 60]); // rect
  });

  it("builds a SharedArrayBuffer-backed Flatbush that queries by store index", () => {
    const data = buildIndex(store)!;
    expect(data).toBeInstanceOf(SharedArrayBuffer);
    const fb = openIndex(data); // zero-copy reconstruct, as a worker would
    expect(sortNum(fb.search(0, 0, 20, 20))).toEqual([0]);
    expect(sortNum(fb.search(90, 90, 110, 110))).toEqual([1]);
    expect(sortNum(fb.search(-1, -1, 200, 200))).toEqual([0, 1, 2]);
    expect(sortNum(fb.search(500, 500, 600, 600))).toEqual([]);
  });

  it("returns undefined for an empty store (Flatbush requires >=1 item)", () => {
    expect(buildIndex({ ...store, count: 0 })).toBeUndefined();
  });
});
