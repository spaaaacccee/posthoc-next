import { AccountTreeOutlined } from "@mui-symbols-material/w300";
import { Box, useTheme } from "@mui/material";
import { Block } from "components/generic/Block";
import { LayerPicker } from "components/generic/LayerPicker";
import { Spinner } from "components/generic/Spinner";
import { useSurfaceAvailableCssSize } from "components/generic/surface/useSurfaceSize";
import { Placeholder } from "components/inspector/Placeholder";
import { useViewTreeContext } from "components/inspector/ViewTree";
import { getColorHex } from "components/renderer/colors";
import { isEmpty } from "es-toolkit/compat";
import { flattenSubtree } from "hooks/useHighlight";
import { inferLayerName } from "layers/inferLayerName";
import type { D2RendererV2 } from "internal-renderers/src/d2-renderer/D2RendererV2";
import { useCallback, useMemo, useState } from "react";
import { useThrottle } from "react-use";
import { AutoSizer as AutoSize } from "react-virtualized-auto-sizer";
import { slice } from "slices";
import { useLayerPicker, WithLayer } from "slices/layers";
import { PanelState } from "slices/view";
import { set } from "utils/set";
import { PageContentProps } from "../PageMeta";
import { eventOf } from "./graph/buildGraphStore";
import { GraphAxis } from "./graph/GraphAxis";
import { FocusedView, GraphControls } from "./graph/GraphControls";
import { GraphRenderer } from "./graph/GraphRenderer";
import { useGraphShading, useGraphStore } from "./graph/GraphStoreWorker";
import { ScatterPlotControls } from "./ScatterPlotControls";
import { SharedGraphProps } from "./SharedGraphProps";

import { isTreeLayer, TreeLayer } from "./TreeLayer";
import { useTreeLayout } from "./TreeLayoutWorker";
import { TreeMenu } from "./TreeMenu";
import { useHighlighting } from "./useHighlighting";
import { useSelection } from "./useSelection";
import { useTreeOptions } from "./useTreeOptions";
import { useTreePageState } from "./useTreePageState";

type TreePageContext = PanelState;

/**
 * The graph view, rendered through D2RendererV2 — the same tiled, worker-parallel,
 * spatially-indexed renderer as the map view, rather than sigma.
 *
 * The playhead is *not* a build input. Scrubbing calls `setStep` and nothing else:
 * no graph is rebuilt, no node is recoloured on the main thread, no column is
 * repacked. Colour follows the step through the store's ramps, which the renderer
 * resolves at draw time. That is what makes a 717k-body graph scrub.
 */
export function TreePage({ template: Page }: PageContentProps) {
  const theme = useTheme();

  const { key, setKey } = useLayerPicker(isTreeLayer);
  const one = slice.layers.one<TreeLayer>(key);
  const { trace, step } = useTreePageState(key);

  const options = useTreeOptions(key);
  const { mode, isLoading: isOptionsLoading, trackedProperty, logAxis, axis } = options;

  const throttled = useThrottle(step ?? 0, 1000 / 24);

  const { controls, onChange, state, dragHandle } = useViewTreeContext<TreePageContext>();
  const size = useSurfaceAvailableCssSize();

  const highlighting = useHighlighting(key);
  const { point, selected, selection, setSelection } = useSelection(throttled, trace?.content);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renderer, setRenderer] = useState<D2RendererV2>();
  // Rotation swaps the laid-out coordinates rather than re-running dagre, so the
  // (expensive) layout stays cached across a rotate.
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("vertical");

  // Dagre still lays out tree and directed-graph modes; plot mode needs no layout
  // at all, since x/y come straight from the events. That asymmetry is why plot is
  // the mode that reaches the big traces.
  const { data: layout, isLoading: isLayoutLoading } = useTreeLayout({
    trace: trace?.content,
    mode: mode === "plot" ? "tree" : mode,
    key: trace?.key,
  });

  const colors = useMemo(() => paletteFor(trace?.content?.events), [trace?.content?.events]);

  const background = theme.palette.background.paper;
  const edgeColor = theme.palette.divider;
  // The un-searched tree. Faint, but present from step 0, so the shape of the whole
  // search is visible before the playhead reaches it.
  const ghostColor = theme.palette.action.disabledBackground;

  const { data: graph, isLoading: isGraphLoading } = useGraphStore({
    key: trace?.key,
    trace: trace?.content,
    mode,
    layout,
    orientation,
    x: axis.xMetric,
    y: axis.yMetric,
    log: logAxis.x || logAxis.y,
    colors,
    background,
    edgeColor,
    ghostColor,
  });

  // A focused view is a flat list of step indices, whichever shape it arrived in.
  const highlight = useMemo(() => {
    const path = highlighting?.path;
    if (!path) return undefined;
    return Array.isArray(path) ? path : flattenSubtree(path);
  }, [highlighting]);

  // Highlighting and colour-by-property are both *recolours*: they rewrite two
  // columns and reuse the geometry and the spatial index untouched. Neither
  // rebuilds the store.
  const { data: shading } = useGraphShading({
    key: trace?.key,
    trace: trace?.content,
    geometry: { count: graph?.store.count ?? 0 },
    nodeOffset: graph?.nodeOffset ?? 0,
    preRamp: graph?.preRamp ?? new Uint8Array(),
    generation: (graph?.store.generation ?? 0) + 1,
    colors,
    background,
    edgeColor,
    ghostColor,
    highlight,
    trackedProperty: trackedProperty || undefined,
  });

  const handleClick = useCallback(
    (hit: { index: number } | undefined, e: Event) => {
      if (!hit || !graph) return;
      // Nodes are packed after edges, so a body index *is* an event index once the
      // edges are subtracted. No lookup table, no second index.
      const i = eventOf(graph, hit.index);
      const id = i === undefined ? undefined : graph.store.strings[graph.store.label[hit.index]!];
      if (!id) return;
      setSelection({ event: e as MouseEvent, node: id });
      setMenuOpen(true);
    },
    [graph, setSelection],
  );

  const isLoading = isLayoutLoading || isOptionsLoading || isGraphLoading;
  const empty = !isLoading && !graph?.store.count;

  return (
    <Page onChange={onChange} stack={state}>
      <Page.Key>tree</Page.Key>
      <Page.Title>Graph</Page.Title>
      <Page.Handle>{dragHandle}</Page.Handle>
      <Page.Content>
        <Block sx={size}>
          {trace ? (
            <>
              <AutoSize
                renderProp={({ width: w, height: h }) => {
                  const width = w ?? 0;
                  const height = h ?? 0;
                  const sharedProps: SharedGraphProps = {
                    width,
                    height,
                    trace: trace?.content,
                    traceKey: trace?.key,
                    trackedProperty,
                    step: throttled,
                    layer: key,
                    onExit: () => {
                      const l = one.get();
                      if (!isEmpty(l?.source?.highlighting)) {
                        one.set((x) => set(x, "source.highlighting", {}));
                      }
                    },
                  };
                  return (
                    <>
                      {isLoading ? (
                        <Box sx={{ width, height }}>
                          <Spinner message="Generating layout" />
                        </Box>
                      ) : empty ? (
                        <WithLayer<TreeLayer> layer={key}>
                          {(l) => (
                            <Placeholder
                              icon={<AccountTreeOutlined />}
                              label="Graph"
                              secondary={`${inferLayerName(l)} is not a graph.`}
                            />
                          )}
                        </WithLayer>
                      ) : (
                        <Box sx={{ width, height, position: "relative" }}>
                          <GraphRenderer
                            width={width}
                            height={height}
                            graph={graph}
                            step={throttled}
                            shading={shading}
                            onClickBody={handleClick}
                            onRenderer={setRenderer}
                            fitKey={mode}
                          />
                          {mode === "plot" && (
                            <GraphAxis
                              renderer={renderer}
                              scales={graph?.scales}
                              width={width}
                              height={height}
                            />
                          )}
                          <FocusedView {...sharedProps} />
                          <GraphControls
                            layer={key}
                            renderer={renderer}
                            isHighlightingEnabled={!!highlight?.length}
                            orientation={mode === "plot" ? undefined : orientation}
                            setOrientation={setOrientation}
                          />
                        </Box>
                      )}
                      <ScatterPlotControls {...sharedProps} {...options} />
                    </>
                  );
                }}
              />
              {menuOpen && (
                <TreeMenu
                  onClose={() => setMenuOpen(false)}
                  anchorReference="anchorPosition"
                  anchorPosition={{ left: point.x, top: point.y }}
                  transformOrigin={{ horizontal: "left", vertical: "top" }}
                  open={menuOpen}
                  layer={key}
                  selected={selected}
                  selection={selection}
                />
              )}
            </>
          ) : (
            <Placeholder
              icon={<AccountTreeOutlined />}
              label="Graph"
              secondary="When you load a trace that has tree-like data, you'll see it here as a decision tree."
            />
          )}
        </Block>
      </Page.Content>
      <Page.Options>
        <LayerPicker onChange={setKey} value={key} guard={isTreeLayer} />
      </Page.Options>
      <Page.Extras>{controls}</Page.Extras>
    </Page>
  );
}

/**
 * Event type -> CSS colour, resolved here because a worker has no theme. Handed to
 * the store build, where each type becomes a ramp fading towards the background.
 */
function paletteFor(events: { type?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = { "": getColorHex("") };
  for (const e of events ?? []) {
    const t = String(e.type ?? "");
    if (!(t in out)) out[t] = getColorHex(t);
  }
  return out;
}
