export * from "./src/d2-renderer";
import { D2Renderer, D2RendererV2 } from "./src/d2-renderer";
import { D2MinimalRenderer } from "./src/d2-minimal-renderer";
import { RendererDefinition } from "renderer";

export default {
  // `d2-renderer` is the shared-memory renderer; the previous generation stays
  // available as `d2-renderer-legacy`. `d2-renderer-v2` is kept as an alias so
  // persisted settings pointing at the old beta URL still resolve.
  "d2-renderer": D2RendererV2,
  "d2-renderer-legacy": D2Renderer,
  "d2-renderer-v2": D2RendererV2,
  "d2-minimal-renderer": D2MinimalRenderer,
} as Record<string, RendererDefinition<any, any, any>>;
