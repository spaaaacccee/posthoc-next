import "@vitest/web-worker";
import "vitest-canvas-mock";

// jsdom has no OffscreenCanvas, but the render workers rasterize onto one. Back
// a minimal shim with a regular <canvas>, whose 2D context `vitest-canvas-mock`
// already stubs. (The previous `jest-webgl-canvas-mock` import was undeclared,
// assumed jest globals, and mocked WebGL that nothing under test uses.)
if (typeof globalThis.OffscreenCanvas === "undefined") {
  class OffscreenCanvasShim {
    #canvas: HTMLCanvasElement;
    constructor(
      public width: number,
      public height: number,
    ) {
      this.#canvas = document.createElement("canvas");
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    getContext(contextId: string, options?: unknown) {
      return this.#canvas.getContext(contextId as "2d", options as object);
    }
    transferToImageBitmap() {
      return { width: this.width, height: this.height, close() {} };
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
