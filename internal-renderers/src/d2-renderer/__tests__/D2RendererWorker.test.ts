import { D2RendererOptions, defaultD2RendererOptions } from "d2-renderer/D2RendererOptions";
import { D2RendererWorker } from "d2-renderer/D2RendererWorker";
import { describe, expect, it, vi } from "vitest";

function makeWorker(options?: Partial<D2RendererOptions>) {
  const worker = new D2RendererWorker();
  worker.setup({
    ...defaultD2RendererOptions,
    workerCount: 1,
    workerIndex: 0,
    ...options,
  });
  return worker;
}

/** Renders are throttled on `refreshInterval` (~42ms) with a trailing edge. */
const flush = () => new Promise((r) => setTimeout(r, defaultD2RendererOptions.refreshInterval * 2));

const rect = () => ({
  component: {
    $: "rect" as const,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    alpha: 1,
    fill: "#000000",
    fontSize: 1,
    text: "",
    label: "",
  },
  meta: {},
});

describe("D2RendererWorker", () => {
  it("initializes", () => {
    expect(makeWorker).not.toThrow();
  });

  describe("setFrustum", () => {
    it("initialises", () => {
      const worker = makeWorker();
      worker.on("message", vi.fn());
      expect(() => worker.setFrustum({ top: 0, left: 0, bottom: 256, right: 256 })).not.toThrow();
    });

    it("emits tiles on each frustum change", async () => {
      const worker = makeWorker();
      const f = vi.fn();
      worker.on("message", f);

      worker.setFrustum({ top: 0, left: 0, bottom: 128, right: 128 });
      await flush();
      const afterZoomIn = f.mock.calls.length;
      expect(afterZoomIn).toBeGreaterThan(0);

      worker.setFrustum({ top: 0, left: 0, bottom: 512, right: 512 });
      await flush();
      expect(f.mock.calls.length).toBeGreaterThan(afterZoomIn);
    });
  });

  describe("shouldRender", () => {
    it("a strided worker rasterizes only a subset of the tiles", async () => {
      const single = makeWorker();
      const fSingle = vi.fn();
      single.on("message", fSingle);
      await single.render();

      const strided = makeWorker({ workerIndex: 1, workerCount: 4 });
      const fStrided = vi.fn();
      strided.on("message", fStrided);
      await strided.render();

      expect(fSingle.mock.calls.length).toBeGreaterThan(0);
      expect(fStrided.mock.calls.length).toBeLessThan(fSingle.mock.calls.length);
    });
  });

  describe("add / remove", () => {
    it("adds a component under its id", async () => {
      const worker = makeWorker();
      worker.on("message", vi.fn());
      worker.add([rect()], "test", 1);
      await flush();
      expect(worker.getView().world["test"]).toHaveLength(1);
    });

    it("removes the component again", async () => {
      const worker = makeWorker();
      worker.on("message", vi.fn());
      worker.add([rect()], "test", 1);
      worker.remove("test", 2);
      await flush();
      expect(worker.getView().world["test"]).toBeUndefined();
    });
  });
});
