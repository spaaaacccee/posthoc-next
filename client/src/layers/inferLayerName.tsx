import { Layer } from "slices/layers";
import { getController } from "./layerControllers";

const UNTITLED = "Untitled Layer";

export function inferLayerName(layer?: Layer<unknown>) {
  if (layer?.name) return layer.name;
  if (!layer?.source?.type) return UNTITLED;
  // `getController` is a plain lookup with no fallback, so a layer whose source
  // type has no registered controller resolves to `undefined` — and calling
  // `inferName` on that threw, rather than falling back to a name. A layer saved
  // by a newer build, or a source type that has since been renamed, is enough.
  const handler = getController(layer);
  return handler?.inferName?.(layer) ?? UNTITLED;
}
