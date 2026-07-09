import { MapOutlined } from "@mui-symbols-material/w300";
import { CircularProgress, Typography } from "@mui/material";
import { MapPicker } from "components/app-bar/Input";
import { custom, readUploadedMap } from "components/app-bar/upload";
import { useRendererInstance } from "components/inspector/TraceRenderer";
import { Heading, Option } from "components/layer-editor/Option";
import { getParser } from "components/renderer";
import { NodeList } from "components/renderer/NodeList";
import { mapParsers } from "components/renderer/map-parser";
import { ParsedMap } from "components/renderer/map-parser/Parser";
import { buildStaticComponentStore } from "components/renderer/parser-v140/sharedComponentStore";
import { useEffectWhen } from "hooks/useEffectWhen";
import { useMapContent } from "hooks/useMapContent";
import { useMapOptions } from "hooks/useMapOptions";
import { useParsedMap } from "hooks/useParsedMap";
import { LayerController, inferLayerName } from "layers";
import { isUndefined, round } from "es-toolkit";
import { get, keys, map, pick, set, startCase, toPairs as entries } from "es-toolkit/compat";
import { nanoid as id } from "nanoid";
import { withProduce } from "produce";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { SourceHandle } from "renderer";
import { slice } from "slices";
import { rendererContent } from "slices/renderers";
import { Map } from "slices/UIState";
import { Layer } from "slices/layers";
import { useOne } from "slices/useOne";
import { ext, name } from "utils/path";

export type MapLayerData = {
  map?: Map;
  options?: Record<string, any>;
  parsedMap?: ParsedMap & { error?: string };
};

export type MapLayer = Layer<MapLayerData>;

type MapRendererProps = { layer?: MapLayer; index?: number };

/** Legacy add()-based map feed. */
function MapNodeListRenderer({ layer, index }: MapRendererProps) {
  const { nodes } = layer?.source?.parsedMap ?? {};
  const nodes2 = useMemo(
    () => [
      map(nodes, (n) => ({
        ...n,
        meta: {
          ...n.meta,
          sourceLayer: layer?.key,
          sourceLayerIndex: index,
          sourceLayerAlpha: 1 - 0.01 * +(layer?.transparency ?? 0),
          sourceLayerDisplayMode: layer?.displayMode ?? "source-over",
        },
      })),
    ],
    [nodes, index, layer?.key, layer?.transparency, layer?.displayMode],
  );
  return <NodeList nodes={nodes2} />;
}

/**
 * Load-based map feed for renderers advertising `supportsLoad`. A map is static
 * (no playback), so its components pack into a shared store once with
 * always-visible spans and `load()` — no per-step feed.
 */
function MapLoadRenderer({ layer, index }: MapRendererProps) {
  const { renderer } = useRendererInstance();
  const nodes = layer?.source?.parsedMap?.nodes;
  const params = useMemo(
    () => ({
      index,
      alpha: 1 - 0.01 * Number(layer?.transparency ?? 0),
      displayMode: (layer?.displayMode ?? "source-over") as GlobalCompositeOperation,
      sourceLayer: layer?.key,
    }),
    [index, layer?.transparency, layer?.displayMode, layer?.key],
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const handleRef = useRef<SourceHandle | undefined>(undefined);

  // Cached per parsed map, so navigating back to the viewport doesn't repack it.
  const { data: store } = useQuery({
    queryKey: ["map-store", layer?.key, layer?.viewKey],
    queryFn: () => buildStaticComponentStore(nodes as { component?: Record<string, any> }[]),
    enabled: !!nodes?.length,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!renderer?.load || !store) return;
    const handle = renderer.load(store, paramsRef.current);
    handleRef.current = handle;
    rendererContent.bump();
    return () => {
      renderer.unload?.(handle);
      handleRef.current = undefined;
      rendererContent.bump();
    };
  }, [renderer, store]);

  useEffect(() => {
    if (handleRef.current) renderer?.setLayerParams?.(handleRef.current, params);
  }, [renderer, params]);

  return <></>;
}

function MapRendererDispatch({ layer, index }: MapRendererProps) {
  const { renderer } = useRendererInstance();
  if (renderer?.load) return <MapLoadRenderer layer={layer} index={index} />;
  return <MapNodeListRenderer layer={layer} index={index} />;
}

export const controller = {
  key: "map",
  icon: <MapOutlined />,
  inferName: (layer) =>
    layer?.source?.map
      ? `${layer.source.map.name} (${startCase(layer.source.map.format)})`
      : "Untitled Map",
  error: (layer) => layer?.source?.parsedMap?.error,
  compress: (layer) => pick(layer, ["map", "options"]),
  claimImportedFile: async (file) =>
    file && keys(mapParsers).includes(ext(file.name))
      ? {
          claimed: true,
          layer: async (notify) => {
            notify("Opening map...");
            try {
              const output = readUploadedMap(
                file,
                entries(mapParsers).map(([k]) => ({ id: k })),
              );
              return { map: { ...(await output.read()) } };
            } catch (e) {
              console.error(e);
              notify(`Error opening, ${get(e, "message")}`);
              return {
                map: {
                  key: id(),
                  id: custom().id,
                  error: get(e, "message"),
                  name: startCase(name(file.name)),
                },
              };
            }
          },
        }
      : { claimed: false },
  editor: withProduce(({ value, produce }) => {
    const parsedMap = value?.source?.parsedMap;
    const { result: Editor } = useMapOptions(parsedMap);
    return (
      <>
        <Option
          label="Source"
          content={
            <MapPicker
              value={value?.source?.map}
              onChange={(v) => produce((d) => set(d, "source.map", v))}
            />
          }
        />
        {parsedMap?.error && (
          <Typography
            component="div"
            variant="body2"
            color="error"
            sx={{ whiteSpace: "pre-wrap", mb: 1, mt: 1 }}
          >
            <code>{parsedMap?.error}</code>
          </Typography>
        )}
        {!!parsedMap && (
          <>
            <Heading label="Map Options" />
            {Editor ? (
              <Editor
                value={value?.source?.options}
                onChange={(v) =>
                  produce((prev) => void set(prev, "source.options", v(prev.source?.options ?? {})))
                }
              />
            ) : (
              <CircularProgress sx={{ mt: 2 }} />
            )}
          </>
        )}
      </>
    );
  }),
  renderer: ({ layer, index }) => <MapRendererDispatch layer={layer} index={index} />,
  service: withProduce(({ value, produce }) => {
    const { result: mapContent } = useMapContent(value?.source?.map);
    const { result: parsedMap, loading } = useParsedMap(mapContent, value?.source?.options);
    useEffectWhen(
      () => {
        if (!loading) {
          void produce((v) => {
            set(v, "source.parsedMap", parsedMap);
            set(v, "viewKey", id());
          });
        }
      },
      [parsedMap, loading, produce],
      [parsedMap],
    );
    return <></>;
  }),
  provideSelectionInfo: ({ children, event, layer: key }) => {
    const one = slice.layers.one<MapLayer>(key);
    const layer = useOne(one);
    const { parsedMap } = layer?.source ?? {};
    const { point, node } = useMemo(() => {
      if (parsedMap && event) {
        const hydratedMap = getParser(layer?.source?.map?.format)?.hydrate?.(parsedMap);
        if (hydratedMap) {
          const point = event?.world && hydratedMap.snap(event.world);
          if (point) {
            const node = event?.world && hydratedMap.nodeAt(point);
            return { point, node };
          }
        }
      }
      return {};
    }, [parsedMap, event, layer?.source?.map?.format]);
    const menu = useMemo(
      () => ({
        ...(layer &&
          point &&
          !isUndefined(node) && {
            [layer.key]: {
              primary: inferLayerName(layer),
              items: {
                point: {
                  primary: "Point",
                  secondary: `(${round(point.x, 2)}, ${round(point.y, 2)})`,
                },
              },
            },
          }),
      }),
      [point, node, layer],
    );
    return <>{children?.(menu)}</>;
  },
  getSources: (layer) => {
    const map = layer?.source?.map;
    const parsedMap = layer?.source?.parsedMap;
    if (map) {
      return [
        {
          id: "map",
          readonly: true,
          name: `${map.name}`,
          language: "txt",
          content: parsedMap?.content,
        },
      ];
    } else return [];
  },
} satisfies LayerController<"map", MapLayerData>;
