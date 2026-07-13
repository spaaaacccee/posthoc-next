import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  openIndex,
  QueryScratch,
  queryVisible,
} from "internal-renderers/src/d2-renderer/columnarIndex";
import {
  columnarDrawTransform,
  pxSize,
  screenPad,
  SPLAT_RADIUS_PX,
  type DrawOptions,
} from "internal-renderers/src/d2-renderer/columnarDraw";
import { getTiles } from "internal-renderers/src/d2-renderer/D2RendererWorker";
import type { Trace } from "protocol/Trace-v140";
import { buildGraphStore } from "../buildGraphStore";

/** What `GraphRenderer` actually renders under. Both values change the answer. */
const TILE = { width: 256, height: 256 }; // devicePixelRatio(2) * TILE_RESOLUTION(128)
const SCREEN = 1130; // css px of the graph pane
const SUBDIVISION = 3;

/**
 * Tile pixels per CSS pixel, as the renderer resolves it: against the tile grid's
 * *nominal* density, not the camera. See `D2RendererV2.handleFrustumChange`.
 */
const PIXEL_SCALE = TILE.width / (SCREEN / 2 ** (SUBDIVISION + 0.5));

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
        ghostColor: "#eeeeee",
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

    // Fitted to the content: every body on screen at once. The worst case.
    //
    // Measured at the tiling the app actually renders under — `GraphRenderer` runs
    // `tileSubdivision: 3` into 512px tiles — because *both* of those decide the
    // answer. An earlier version of this test measured a single subdivision-0 tile,
    // whose world-to-pixel scale is 16x smaller, and so concluded the splat path
    // engaged when in the real renderer it never did.
    const b = result.bounds;
    const frustum = { left: b.minX, right: b.maxX, top: b.minY, bottom: b.maxY };
    const tiles = getTiles(frustum, SUBDIVISION, false).tiles;
    const scratch = new QueryScratch();

    // The last valid step. Spans are half-open, so at `total` nothing is alive.
    const last = store.total - 1;

    const t = columnarDrawTransform(tiles[0]!.bounds, TILE);
    const opts: DrawOptions = {
      step: last,
      sizing: result.params.sizing,
      label: result.params.label,
      pixelScale: PIXEL_SCALE,
    };

    let draws = 0;
    let worst = 0;
    const query = ms(() => {
      for (const { bounds } of tiles) {
        const pad = screenPad(store, t.sx, opts);
        const out = queryVisible(
          store,
          fb,
          {
            left: bounds.left - pad,
            right: bounds.right + pad,
            top: bounds.top - pad,
            bottom: bounds.bottom + pad,
          },
          last,
          { scratch },
        );
        draws += out.length;
        if (out.length > worst) worst = out.length;
      }
    });

    // The pixel radius a node actually draws at, resolved through the same `pxSize`
    // the renderer uses, from the size the store actually **packed** — not from a
    // constant restated here. Restating it is what let the two drift: the store held
    // 20 world units, this test asserted about 2, and the clamp turned the real
    // value into a 20px ellipse per point, 717,447 times a frame.
    const sizing = result.params.sizing!.circle;
    // In CSS pixels — what the eye actually sees, and what the splat threshold means.
    //
    // Two different scales, deliberately. `pxSize` resolves the CSS clamps through the
    // *nominal* one, because that is what the renderer hands it; converting the tile
    // pixels it returns back into what lands on screen goes through the *actual* one.
    // They differ by up to sqrt(2) — the tile grid's density against the camera's — and
    // that gap is exactly the breathing a grid-anchored size has.
    const actual = t.sx / (SCREEN / (frustum.right - frustum.left));
    const nodeRadiusPx = pxSize(store.size[result.nodeOffset]!, t.sx, sizing, PIXEL_SCALE) / actual;

    // How many tiles the average body is drawn into. A body's indexed box is derived
    // from its `size`, so an oversized radius doesn't just make each draw dearer —
    // it fans the body out across every tile its box touches, and pays that cost
    // again in each. At 20 world units against a 64-unit tile that was ~13x.
    const fanout = draws / store.count;

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
        `  query, ${String(tiles.length).padStart(3)} tiles ${query.toFixed(1)} ms  (${draws.toLocaleString()} draws, worst tile ${worst.toLocaleString()})`,
        ``,
        `  node radius @ fit: ${nodeRadiusPx.toFixed(2)} px -> ${nodeRadiusPx <= SPLAT_RADIUS_PX ? "SPLAT (1 fillRect each)" : "ELLIPSE (slow path!)"}`,
        `  draws per body:    ${fanout.toFixed(2)}x`,
        ``,
      ].join("\n"),
    );

    // One body per event.
    expect(store.count).toBe(trace.events!.length);
    // The claim the design rests on: fitted to the viewport, the whole 717k-point
    // cloud draws through the splat path — one `fillRect` per node, not an ellipse.
    // If this regresses, a fitted scatter strokes 717k ellipses and the frame budget
    // is gone.
    expect(nodeRadiusPx).toBeLessThanOrEqual(SPLAT_RADIUS_PX);
    // And it draws each of them about *once*. This is the half that the radius check
    // alone misses: the radius sets the cost of one draw, the fan-out sets how many
    // draws there are, and a bloated `size` inflates both at once.
    // Generous, deliberately: this guards against the *12.9x* blowup an oversized
    // radius caused, not against a few percent of tile-edge straddling.
    expect(fanout).toBeLessThan(1.4);
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
      ghostColor: "#eee",
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
      ghostColor: "#eee",
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
