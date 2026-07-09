import { makeRenderer } from "renderer";
import { D2Renderer } from "./D2Renderer";

/**
 * Next-generation D2 renderer. Registered alongside `d2-renderer` so the two
 * coexist: selecting this renderer is the A/B switch and the rollback.
 *
 * P0 scaffold — it currently inherits the existing `add()`-based behaviour
 * unchanged (so it renders identically to `d2-renderer`). The shared-columnar
 * `load()`/`setStep()` path is implemented in later phases; `supportsLoad` flips
 * to `true` only once that path is real (so the app keeps using `add()` until
 * then).
 */
export class D2RendererV2 extends D2Renderer {}

export default makeRenderer(D2RendererV2, {
  components: ["rect", "circle", "path", "polygon"],
  id: "d2-renderer-v2",
  name: "Pixel (beta)",
  description: "Shared-memory 2D renderer (beta)",
  version: "0.1.0",
  supportsLoad: false,
});
