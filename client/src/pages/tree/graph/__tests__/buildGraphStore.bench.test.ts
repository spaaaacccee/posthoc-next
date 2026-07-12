import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  openIndex,
  QueryScratch,
  queryVisible,
} from "internal-renderers/src/d2-renderer/columnarIndex";
import { pxSize, SPLAT_RADIUS_PX } from "internal-renderers/src/d2-renderer/columnarDraw";
import { getTiles } from "internal-renderers/src/d2-renderer/D2RendererWorker";
import type { Trace } from "protocol/Trace-v140";
import { buildGraphStore, graphLayerParams } from "../buildGraphStore";

/**
 * Scale check against a real trace, in plot mode — the mode that actually reaches
 * the sizes in question, since it emits a body per *event* rather than per node.
 *
 * This measures the CPU pipeline only (synthesize, index, query). Rasterization
 * needs a real canvas and is verified in the browser. What it is here to establish
 * is the claim the whole design rests on: that the spatial index bounds the work a
 * tile does by *what is on screen*, not by how big the trace is.
 */

const TRACE = resolve(__dirname, "../../../../../../experiments/700k-nodes.trace.json");

const ms = (f: () => void) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

const suite = existsSync(TRACE) ? describe : describe.skip;

suite("scale: 717k events, plot mode", () => {
  const trace = JSON.parse(readFileSync(TRACE, "utf8")) as Trace;

  it("synthesizes, indexes and queries a 717k-body graph", () => {
    expect(trace.events!.length).toBeGreaterThan(700_000);

    let result!: ReturnType<typeof buildGraphStore>;
    const build = ms(() => {
      result = buildGraphStore({
        trace,
        mode: "plot",
        x: "x",
        y: "y",
        colors: { generating: "#2196f3", source: "#4caf50", destination: "#f44336" },
        background: "#ffffff",
        edgeColor: "#cccccc",
        labelColor: "#000000",
      });
    });
    const { store } = result;

    let index!: SharedArrayBuffer;
    const pack = ms(() => {
      index = buildIndex(store)!;
    });
    const fb = openIndex(index);

    // Bytes actually held, so the memory claim is measured rather than asserted.
    const mb = (
      (store.count * (1 + 4 * 8 + 1 + 1) + store.pts.length * 4 + index.byteLength) /
      1e6
    ).toFixed(1);

    // Zoomed all the way out: every body on screen at once. The worst case.
    const b = result.bounds;
    const frustum = { left: b.minX, right: b.maxX, top: b.minY, bottom: b.maxY };
    const tiles = getTiles(frustum, 0).tiles;
    const scratch = new QueryScratch();

    // The last valid step. Spans are half-open, so at `total` nothing is alive.
    const last = store.total - 1;

    let hits = 0;
    let worst = 0;
    const query = ms(() => {
      for (const { bounds } of tiles) {
        const out = queryVisible(store, fb, bounds, last, { scratch });
        hits += out.length;
        if (out.length > worst) worst = out.length;
      }
    });

    // The pixel radius a node actually draws at when fully zoomed out, resolved
    // through the same `pxSize` the renderer uses — including the layer's clamp,
    // which is the thing that decides whether the splat path engages at all.
    const tileScale = 512 / (tiles[0]!.bounds.right - tiles[0]!.bounds.left);
    const sizing = graphLayerParams("#000").sizing!.circle;
    const nodeRadiusPx = pxSize(2, tileScale, sizing);

    console.log(
      [
        ``,
        `  events            ${trace.events!.length.toLocaleString()}`,
        `  bodies            ${store.count.toLocaleString()}`,
        `  ramps             ${store.ramps!.length}`,
        `  memory            ${mb} MB (columns + Flatbush)`,
        ``,
        `  buildGraphStore   ${build.toFixed(0)} ms`,
        `  packIndex         ${pack.toFixed(0)} ms`,
        `  query, ${String(tiles.length).padStart(2)} tiles  ${query.toFixed(1)} ms  (${hits.toLocaleString()} hits, worst tile ${worst.toLocaleString()})`,
        ``,
        `  node radius @ fit-to-content: ${nodeRadiusPx.toFixed(2)} px -> ${nodeRadiusPx <= SPLAT_RADIUS_PX ? "SPLAT (1 fillRect each)" : "ELLIPSE (slow path!)"}`,
        ``,
      ].join("\n"),
    );

    // One body per event.
    expect(store.count).toBe(trace.events!.length);
    // Every body found: plot bodies are persistent, so at the last step the whole
    // cloud is live. (Slightly more than `count`, since a body straddling a tile
    // edge is returned by both.)
    expect(hits).toBeGreaterThanOrEqual(store.count);
    // The claim the design rests on: fitted to the viewport, the whole 717k-point
    // cloud draws through the splat path — one `fillRect` per node, not an
    // ellipse. If this ever regresses, a fitted scatter strokes 717k ellipses and
    // the frame budget is gone.
    expect(nodeRadiusPx).toBeLessThanOrEqual(SPLAT_RADIUS_PX);
  }, 120_000);

  it("returns only what is on screen as you zoom in", () => {
    // The load-bearing property. A tile's cost must track its *contents*, not the
    // trace's size — otherwise nothing else in the design matters.
    const result = buildGraphStore({
      trace,
      mode: "plot",
      x: "x",
      y: "y",
      colors: {},
      background: "#ffffff",
      edgeColor: "#ccc",
      labelColor: "#000",
    });
    const { store } = result;
    const fb = openIndex(buildIndex(store)!);
    const scratch = new QueryScratch();
    const b = result.bounds;
    const w = b.maxX - b.minX;

    // Zoom towards the *median* body, not the centre of the bounding box. This
    // trace's source and destination sit far outside the search's own footprint, so
    // they stretch the box and its centre lands in empty space — zooming there
    // would measure nothing. A user zooms into the data.
    const median = (a: Float32Array) => {
      const s = Float32Array.from(a.subarray(0, store.count)).sort();
      return s[s.length >> 1]!;
    };
    const cx = median(store.x);
    const cy = median(store.y);

    const rows: string[] = [];
    let previous = Infinity;
    for (const zoom of [1, 4, 16, 64, 256]) {
      const half = w / (2 * zoom);
      const bounds = { left: cx - half, right: cx + half, top: cy - half, bottom: cy + half };
      let hits = 0;
      const t = ms(() => {
        hits = queryVisible(store, fb, bounds, store.total - 1, { scratch }).length;
      });
      rows.push(
        `  ${String(zoom).padStart(4)}x   ${String(hits.toLocaleString()).padStart(9)} bodies   ${t.toFixed(2)} ms`,
      );
      // Zooming in never returns *more* work than zooming out.
      expect(hits).toBeLessThanOrEqual(previous);
      previous = hits;
    }
    console.log(`\n  centre viewport, by zoom:\n${rows.join("\n")}\n`);
  }, 120_000);

  it("spreads a clustered graph across workers as tiles subdivide", () => {
    // Tiles are striped across workers one-for-one, so a tile's body count *is* a
    // worker's share of the frame. Real search data is heavily clustered — this
    // trace puts 80% of its bodies in one tile at the default subdivision — so
    // without subdividing, one worker draws almost the whole graph and the other
    // seven idle. `tileSubdivision` is the knob; this measures where it should sit.
    const result = buildGraphStore({
      trace,
      mode: "plot",
      x: "x",
      y: "y",
      colors: {},
      background: "#ffffff",
      edgeColor: "#ccc",
      labelColor: "#000",
    });
    const { store } = result;
    const fb = openIndex(buildIndex(store)!);
    const scratch = new QueryScratch();
    const b = result.bounds;
    const frustum = { left: b.minX, right: b.maxX, top: b.minY, bottom: b.maxY };
    const last = store.total - 1;

    const rows: string[] = [];
    let bestShare = 1;
    for (const subdivision of [0, 1, 2, 3, 4]) {
      const tiles = getTiles(frustum, subdivision, false).tiles;
      let worst = 0;
      let hits = 0;
      for (const { bounds } of tiles) {
        const k = queryVisible(store, fb, bounds, last, { scratch }).length;
        hits += k;
        if (k > worst) worst = k;
      }
      const share = worst / hits;
      bestShare = Math.min(bestShare, share);
      rows.push(
        `  subdivision ${subdivision}: ${String(tiles.length).padStart(4)} tiles, worst tile ${String(worst.toLocaleString()).padStart(9)}  (${(share * 100).toFixed(0)}% of the frame)`,
      );
    }
    console.log(`\n  load balance, fitted to content:\n${rows.join("\n")}\n`);

    // Subdividing has to actually break the cluster up, or worker parallelism is
    // a fiction on exactly the data that needs it.
    expect(bestShare).toBeLessThan(0.2);
  }, 120_000);
});
