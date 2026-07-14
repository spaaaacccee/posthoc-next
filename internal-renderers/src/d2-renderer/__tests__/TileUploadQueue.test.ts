import type { Bounds } from "protocol";
import { describe, expect, it } from "vitest";
import { TileUploadQueue } from "../TileUploadQueue";

const at = (left: number, top: number): Bounds => ({
  left,
  top,
  right: left + 10,
  bottom: top + 10,
});

const key = (b: Bounds) => `${b.left},${b.top}`;

/** A stand-in for an ImageBitmap: the only thing the queue asks of one is `close`. */
function bitmap(id: string) {
  return { id, closed: false, close() { this.closed = true; } };
}

const queue = () => new TileUploadQueue<ReturnType<typeof bitmap>>(key);

describe("TileUploadQueue", () => {
  it("drains in insertion order, up to the budget", () => {
    const q = queue();
    const a = bitmap("a");
    const b = bitmap("b");
    const c = bitmap("c");
    q.push(at(0, 0), "h1", a);
    q.push(at(10, 0), "h2", b);
    q.push(at(20, 0), "h3", c);

    const applied: string[] = [];
    expect(q.drain(2, (u) => applied.push(u.bitmap.id))).toBe(2);
    expect(applied).toEqual(["a", "b"]);
    expect(q.size).toBe(1); // `c` waits for the next frame

    expect(q.drain(2, (u) => applied.push(u.bitmap.id))).toBe(1);
    expect(applied).toEqual(["a", "b", "c"]);
    expect(q.size).toBe(0);
  });

  it("keeps only the newest bitmap per tile, and closes the one it displaces", () => {
    // The leak this guards: a scrub mints a bitmap per dirty tile per frame, so a
    // tile can be re-rendered several times before the main thread uploads any of
    // them. Every one but the last is dead on arrival.
    const q = queue();
    const stale = bitmap("stale");
    const fresh = bitmap("fresh");
    q.push(at(0, 0), "h1", stale);
    q.push(at(0, 0), "h2", fresh);

    expect(stale.closed).toBe(true);
    expect(fresh.closed).toBe(false);
    expect(q.size).toBe(1);

    const applied: string[] = [];
    q.drain(10, (u) => applied.push(`${u.bitmap.id}:${u.hash}`));
    expect(applied).toEqual(["fresh:h2"]);
  });

  it("does not close a bitmap that is pushed twice", () => {
    const q = queue();
    const a = bitmap("a");
    q.push(at(0, 0), "h1", a);
    q.push(at(0, 0), "h1", a);
    expect(a.closed).toBe(false);
  });

  it("drains everything when the budget is non-positive", () => {
    const q = queue();
    for (let i = 0; i < 5; i++) q.push(at(i * 10, 0), `h${i}`, bitmap(`b${i}`));
    expect(q.drain(0, () => {})).toBe(5);
    expect(q.size).toBe(0);
  });

  it("reports whether a newer bitmap is already waiting for a tile", () => {
    const q = queue();
    expect(q.has(at(0, 0))).toBe(false);
    q.push(at(0, 0), "h1", bitmap("a"));
    expect(q.has(at(0, 0))).toBe(true);
    expect(q.has(at(10, 0))).toBe(false);
  });

  it("releases everything it still holds on clear", () => {
    const q = queue();
    const a = bitmap("a");
    const b = bitmap("b");
    q.push(at(0, 0), "h1", a);
    q.push(at(10, 0), "h2", b);
    q.clear();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(q.size).toBe(0);
  });
});
