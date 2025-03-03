import { once } from "lodash-es";
import { Layer } from "slices/layers";
import { LayerController } from "./LayerController";
import { controller as mapController } from "./map";
import { controller as queryController } from "./query";
import { controller as traceController } from "./trace";

export function getController(layer?: Layer<unknown> | string) {
  return getControllers()[
    typeof layer === "string" ? layer : (layer?.source?.type ?? "")
  ];
}

export const getControllers: () => Record<
  string,
  LayerController<string, any>
> = once(() => ({
  trace: traceController,
  map: mapController,
  query: queryController,
}));
