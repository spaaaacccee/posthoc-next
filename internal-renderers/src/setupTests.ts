import "@vitest/web-worker";
import "vitest-canvas-mock";

// jsdom has no OffscreenCanvas, but the render workers rasterize onto one. Back
// a minimal shim with a regular <canvas>, whose 2D context `vitest-canvas-mock`
// already stubs. (The previous `jest-webgl-canvas-mock` import was undeclared,
// assumed jest globals, and mocked WebGL that nothing under test uses.)
if (typeof globalThis.OffscreenCanvas === "undefined") {
  class OffscreenCanvasShim {
    constructor(width: number, height: number) {
      // Returning an object from a constructor overrides `this`, so
      // `new OffscreenCanvas(w, h)` yields an actual <canvas>. That matters:
      // the renderer composites cached layer rasters with `ctx.drawImage(canvas)`,
      // and the canvas mock type-checks its argument — a wrapper object that
      // merely *holds* a canvas is rejected.
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      Object.assign(canvas, {
        transferToImageBitmap: () => ({ width, height, close() {} }),
      });
      return canvas as unknown as OffscreenCanvasShim;
    }
  }
  Object.assign(globalThis, { OffscreenCanvas: OffscreenCanvasShim });
}

// The workers opportunistically load a webfont. jsdom has neither FontFace nor
// a FontFaceSet; the worker already tolerates failure, but shimming keeps the
// test output free of spurious ReferenceErrors.
if (typeof globalThis.FontFace === "undefined") {
  class FontFaceShim {
    constructor(
      public family: string,
      public source: string,
    ) {}
    async load() {
      return this;
    }
  }
  Object.assign(globalThis, { FontFace: FontFaceShim });
}
if (!("fonts" in globalThis)) Object.assign(globalThis, { fonts: { add() {} } });
