import { store } from "@davstack/store";
import { values } from "es-toolkit/compat";
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

/**
 * Capability of each *mounted* renderer instance, keyed by its mount id: does it
 * drive the shared-store `load()`/`setStep()` contract? Layer services mount
 * outside the renderer's React context, so this is how they learn whether the
 * legacy per-step component generation is still needed.
 */
export const rendererCapabilities = store<Record<string, boolean>>(
  {},
  {
    name: "renderer-capabilities",
    devtools: { enabled: import.meta.env.DEV },
  },
);

/**
 * True when at least one renderer is mounted and *every* one of them uses the
 * load() path — i.e. nothing on screen needs the legacy `add()` component feed,
 * so generating it would be pure waste.
 */
export function useAllRenderersSupportLoad() {
  return useOne(rendererCapabilities, (c) => {
    const v = values(c);
    return v.length > 0 && v.every(Boolean);
  });
}
