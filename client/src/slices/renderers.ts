import { store } from "@davstack/store";
import { head, values } from "es-toolkit/compat";
import { useMemo } from "react";
import { RendererDefinition, RendererEvents, RendererOptions } from "renderer";
import { useOne } from "./useOne";

export type Renderer = {
  key: string;
  url: string;
  renderer: RendererDefinition<RendererOptions, RendererEvents, { $: string }>;
};

export const renderers = store<Renderer[]>([], {
  name: "renderers",
  devtools: { enabled: import.meta.env.DEV },
});

/** Renderer ids that have been renamed; persisted settings may still use them. */
export const RENDERER_ID_ALIASES: Record<string, string> = {
  "d2-renderer-v2": "d2-renderer",
};

export const resolveRendererId = (id?: string) => (id ? (RENDERER_ID_ALIASES[id] ?? id) : id);

/**
 * Capability of each *mounted* renderer instance: does it drive the shared-store
 * `load()`/`setStep()` contract? Layer services mount outside the renderer's
 * React context, so this is how they learn whether the legacy per-step component
 * generation is still needed.
 *
 * `last` remembers the answer from when a renderer was last mounted. Navigating
 * away from the viewport unmounts every renderer; without this the answer would
 * flap, tearing down and restarting the trace-generation fleet on every
 * navigation.
 */
export const rendererCapabilities = store<{
  mounted: Record<string, boolean>;
  last: boolean | undefined;
}>(
  { mounted: {}, last: undefined },
  {
    name: "renderer-capabilities",
    devtools: { enabled: import.meta.env.DEV },
  },
).actions((a) => ({
  mount: (key: string, supportsLoad: boolean) =>
    a.set((s) => {
      s.mounted[key] = supportsLoad;
      s.last = values(s.mounted).every(Boolean);
    }),
  unmount: (key: string) =>
    a.set((s) => {
      delete s.mounted[key];
      // `last` intentionally survives: it's the whole point of the fallback.
    }),
}));

/**
 * True when nothing on screen needs the legacy `add()` component feed, so
 * generating it would be pure waste. Falls back to the last mounted answer, then
 * to the default renderer's declared capability (and, while the registry is
 * still resolving, assumes the default) — so the value never flaps on
 * navigation.
 */
export function useAllRenderersSupportLoad() {
  const caps = useOne(rendererCapabilities);
  const list = useOne(renderers);
  return useMemo(() => {
    const v = values(caps.mounted);
    if (v.length) return v.every(Boolean);
    if (caps.last !== undefined) return caps.last;
    return list.length ? !!head(list)?.renderer?.meta?.supportsLoad : true;
  }, [caps, list]);
}

/**
 * Bumped whenever a renderer layer finishes loading (or is unloaded), i.e. when
 * the visualisation's contents actually changed. The viewport listens so it can
 * fit the camera once there is something to fit — the layer's `viewKey` commits
 * well before the off-main component store finishes building.
 */
export const rendererContent = store<{ version: number }>(
  { version: 0 },
  { name: "renderer-content", devtools: { enabled: import.meta.env.DEV } },
).actions((a) => ({
  bump: () => a.set((s) => void s.version++),
}));
