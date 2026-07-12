import { useTheme } from "@mui/material";
import { scaleLinear, scaleSymlog } from "d3-scale";
import type { D2RendererV2 } from "internal-renderers/src/d2-renderer/D2RendererV2";
import { useEffect, useRef } from "react";
import { applyScale, type AxisScale } from "./buildGraphStore";

/**
 * Scatter-plot axes, drawn as a screen-anchored canvas over the renderer.
 *
 * They stay an overlay rather than becoming world-space bodies, and that is forced
 * rather than chosen: **an axis is anchored to the screen, a tile is anchored to
 * the world.** Tiles are snapped to a fixed world grid (that is what makes them
 * cacheable and pannable), so ticks emitted as bodies would scroll away with the
 * content instead of staying pinned to the edge. The two coordinate systems are
 * incompatible by construction.
 *
 * The cost of keeping it outside the pipeline is nil — this is ~50 ticks a frame on
 * the main thread — and it keeps the renderer entirely ignorant that a log scale
 * exists. The scale is applied at pack time (see `applyScale`), so world space is
 * always linear as far as the tiles are concerned.
 */

/** Nice tick values in *data* space, honouring the axis's linear/symlog scale. */
function ticksOf(axis: AxisScale, count: number): number[] {
  const d3 = axis.log ? scaleSymlog() : scaleLinear();
  return d3.domain([axis.min, axis.max]).ticks(count) as number[];
}

export type GraphAxisProps = {
  renderer?: D2RendererV2;
  scales?: { x: AxisScale; y: AxisScale };
  width: number;
  height: number;
};

export function GraphAxis({ renderer, scales, width, height }: GraphAxisProps) {
  const theme = useTheme();
  const ref = useRef<HTMLCanvasElement>(null);

  const line = theme.palette.divider;
  const text = theme.palette.text.secondary;

  useEffect(() => {
    const canvas = ref.current;
    const viewport = renderer?.getInstance?.()?.viewport;
    if (!canvas || !viewport || !scales || !width || !height) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = devicePixelRatio;

    const draw = () => {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `11px Inter, Helvetica, Arial, sans-serif`;

      // Tick density follows the zoom, so zooming in reveals finer ticks rather
      // than stretching the same handful apart.
      const count = Math.max(2, Math.round(8 * Math.max(1, Math.log2(viewport.scale.x + 1))));

      ctx.strokeStyle = line;
      ctx.fillStyle = text;
      ctx.lineWidth = 1;

      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (const v of ticksOf(scales.x, count)) {
        const { x } = viewport.toScreen(applyScale(scales.x, v), 0);
        if (x < 0 || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillText(format(v), x, height - 4);
      }

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const v of ticksOf(scales.y, count)) {
        const { y } = viewport.toScreen(0, applyScale(scales.y, v));
        if (y < 0 || y > height) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(format(v), 4, y);
      }
    };

    draw();
    // `moved` covers drag, wheel and pinch; `zoomed` covers programmatic fits.
    viewport.on("moved", draw);
    viewport.on("zoomed", draw);
    return () => {
      viewport.off("moved", draw);
      viewport.off("zoomed", draw);
    };
  }, [renderer, scales, width, height, line, text]);

  if (!scales) return null;
  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute",
        inset: 0,
        width,
        height,
        pointerEvents: "none",
      }}
    />
  );
}

const format = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e6 || a < 1e-3) return v.toExponential(1);
  return String(Math.round(v * 1000) / 1000);
};
