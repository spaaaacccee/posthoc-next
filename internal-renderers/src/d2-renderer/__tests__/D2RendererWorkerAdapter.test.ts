import { D2RendererWorkerAdapter } from "d2-renderer/D2RendererWorkerAdapter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The adapter is the envelope: `call` packs an action/payload pair into a
 * `postMessage`, `on` unpacks the matching ones back out. Nothing else. So that
 * is what gets tested — the previous version of this file only asserted that the
 * constructor did not throw, which is true of very nearly any class.
 */
describe("D2RendererWorkerAdapter", () => {
  let adapter: D2RendererWorkerAdapter;

  beforeEach(() => {
    adapter = new D2RendererWorkerAdapter();
  });

  it("packs an action and payload into a message", () => {
    const post = vi.spyOn(adapter, "postMessage");
    const frustum = { left: 0, top: 0, right: 1, bottom: 1 };
    adapter.call("setFrustum" as never, { frustum } as never);
    expect(post).toHaveBeenCalledWith({ action: "setFrustum", payload: { frustum } }, []);
  });

  it("forwards the transfer list", () => {
    const post = vi.spyOn(adapter, "postMessage");
    const buffer = new ArrayBuffer(8);
    adapter.call("setup" as never, {} as never, [buffer]);
    expect(post).toHaveBeenCalledWith({ action: "setup", payload: {} }, [buffer]);
  });

  it("delivers only the events it subscribed to", () => {
    const handler = vi.fn();
    adapter.on("update" as never, handler);

    adapter.dispatchEvent(
      new MessageEvent("message", { data: { action: "update", payload: { tile: 1 } } }),
    );
    adapter.dispatchEvent(
      new MessageEvent("message", { data: { action: "somethingElse", payload: { tile: 2 } } }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ tile: 1 });
  });

  it("stops delivering once unsubscribed", () => {
    const handler = vi.fn();
    const off = adapter.on("update" as never, handler);

    adapter.dispatchEvent(new MessageEvent("message", { data: { action: "update", payload: 1 } }));
    off();
    adapter.dispatchEvent(new MessageEvent("message", { data: { action: "update", payload: 2 } }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });
});
