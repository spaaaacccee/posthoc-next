import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pxSize } from "internal-renderers/src/d2-renderer/columnarDraw";
import { getTiles } from "internal-renderers/src/d2-renderer/D2RendererWorker";
import { parse } from "yaml";
import type { Trace } from "protocol/Trace-v140";
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { buildGraphStore, type NodeLayout } from "../buildGraphStore";

/**
 * Node size across the zoom range, on a real trace.
 *
 * The property under test is that a tree's nodes stay **world-space** over the zoom
 * range anyone actually uses — that they grow as you zoom in. The pixel clamps are
 * guard rails, and if the band between them is narrow the node spends most of the
 * range pinned at one end, which is a world-space graph that *feels* screen-space.
 * That is not a hypothetical: at [3, 24] the node hit its ceiling by 4x and held it
 * for every zoom beyond.
 *
 * Sizes are asserted in **CSS pixels**, which is what the clamps mean and what the eye
 * sees. A tile's own pixels are neither: its bitmap is stretched over its world bounds,
 * and `getTiles` snaps those to a power of two, so tile pixels are ~2-4x a CSS pixel
 * here and the ratio slides with zoom. See `DrawOptions.pixelScale`.
 *
 * Which is why two scales appear below. The renderer hands the draw path a *nominal*
 * one, fixed to the tile grid, so that zooming re-rasterizes nothing; the sizes it
 * produces then land on screen through the *actual* one. Feeding `pxSize` the actual
 * scale here would model a renderer we deliberately do not have.
 */

const TRACE = resolve(__dirname, "../../../../../../experiments/astar-network.trace.yaml");
const suite = existsSync(TRACE) ? describe : describe.skip;

const TILE = 256; // devicePixelRatio(2) * TILE_RESOLUTION(128), per GraphRenderer
const SUBDIVISION = 3;
const SCREEN = 1130; // css px of the graph pane
/** Tile px per CSS px, as the renderer resolves it. See `D2RendererV2.handleFrustumChange`. */
const PIXEL_SCALE = TILE / (SCREEN / 2 ** (SUBDIVISION + 0.5));

suite("tree node sizing", () => {
  const trace = parse(readFileSync(TRACE, "utf8")) as Trace;

  /** Dagre, configured as `treeLayout.worker` does. */
  const layoutOf = (events: Trace["events"]) => {
    const g = new graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    const final = new Map<string, string>();
    const seen = new Set<string>();
    for (const e of events!) {
      const id = String(e.id);
      if (!seen.has(id)) {
        seen.add(id);
        g.setNode(id, { width: 20, height: 20 });
      }
      if (e.pId != null) final.set(id, String(e.pId));
    }
    for (const [id, pId] of final) if (seen.has(pId)) g.setEdge(id, pId, { width: 1, height: 1 });
    g.setGraph({ ranksep: 100, align: "UL", rankdir: "TB" });
    dagreLayout(g);
    const out: NodeLayout[] = [...seen].map((id) => {
      const n = g.node(id);
      return { label: id, x: n.x, y: n.y, size: 1 };
    });
    return out;
  };

  it("keeps a node world-space across the useful zoom range", () => {
    const r = buildGraphStore({
      trace,
      mode: "tree",
      layout: layoutOf(trace.events),
      colors: {},
      background: "#111",
      edgeColor: "#ccc",
      ghostColor: "#888",
      labelColor: "#aaa",
    });
    const fit = Math.max(r.bounds.maxX - r.bounds.minX, r.bounds.maxY - r.bounds.minY);
    const sizing = r.params.sizing!.circle!;
    const world = r.store.size[r.nodeOffset]!;

    /** What a node actually measures on screen, in CSS px, at this zoom. */
    const cssRadius = (zoom: number, override?: Partial<typeof sizing>) => {
      const extent = fit / zoom;
      const half = extent / 2;
      const { tiles } = getTiles(
        { left: -half, right: half, top: -half, bottom: half },
        SUBDIVISION,
        false,
      );
      const b = tiles[0]!.bounds;
      const tileScale = TILE / (b.right - b.left); // tile px per world unit
      // The scale a tile is *drawn* at is the grid's; the scale it is *seen* at is the
      // camera's. They differ by up to sqrt(2) across an octave, and that gap is the
      // breathing that buys us a zoom which re-rasterizes nothing.
      const seen = tileScale / (SCREEN / extent); // tile px per css px, actual
      return pxSize(world, tileScale, { ...sizing, ...override }, PIXEL_SCALE) / seen;
    };

    const rows = [""];
    for (const z of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) {
      const natural = cssRadius(z, { min: 0, damp: undefined });
      rows.push(
        `  ${String(z).padStart(5)}x   natural ${natural.toFixed(2).padStart(7)} px   drawn ${cssRadius(z).toFixed(2).padStart(7)} px   x${(cssRadius(z) / natural).toFixed(2)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));

    // Fitted, a node is a dot rather than a blob: 1242 nodes sit ~5.7 css px apart
    // here, so anything above ~3px across makes them touch.
    expect(cssRadius(1)).toBeGreaterThan(0.5);
    expect(cssRadius(1)).toBeLessThan(2);

    // And it *grows* — every doubling of the zoom is a near-doubling of the node, out
    // to 16x. This is the assertion that a narrow clamp band would break.
    for (const zoom of [1, 2, 4, 8]) {
      const ratio = cssRadius(zoom * 2) / cssRadius(zoom);
      expect(ratio).toBeGreaterThan(1.2);
    }

    // By 16x it is a proper circle you could read a label against.
    expect(cssRadius(16)).toBeGreaterThan(7);
  }, 120_000);
});
