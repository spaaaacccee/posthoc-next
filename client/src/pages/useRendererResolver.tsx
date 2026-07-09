import { head } from "es-toolkit/compat";
import { useMemo } from "react";
import { slice } from "slices";
import { resolveRendererId } from "slices/renderers";
import { useOne } from "slices/useOne";

export function useRendererResolver(renderer?: string) {
  const renderers = useOne(slice.renderers);

  const autoRenderer = useMemo(() => head(renderers), [renderers]);

  return {
    auto: autoRenderer,
    // Persisted state may name a renamed renderer; map it onto its current id.
    selected:
      renderer && renderer !== "internal:auto"
        ? resolveRendererId(renderer)
        : autoRenderer?.renderer?.meta?.id,
  };
}
