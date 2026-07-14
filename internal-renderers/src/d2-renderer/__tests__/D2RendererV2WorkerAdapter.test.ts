import { D2RendererV2WorkerAdapter } from "d2-renderer/D2RendererV2WorkerAdapter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The v2 adapter is the one the app ships (`index.ts` maps `d2-renderer` to the v2
 * renderer), and it had no test at all — the legacy adapter had the only one.
 *
 * Its `call` differs from the legacy adapter's in a way worth pinning: the payload
 * is an *argument list*, because it targets a method on `D2RendererV2Worker` rather
 * than a hand-rolled request union.
 */
describe("D2RendererV2WorkerAdapter", () => {
  let adapter: D2RendererV2WorkerAdapter;

  beforeEach(() => {
    adapter = new D2RendererV2WorkerAdapter();
  });

  it("packs an action and its argument list into a message", () => {
    const post = vi.spyOn(adapter, "postMessage");
    adapter.call("setFrustum" as never, [{ left: 0, top: 0, right: 1, bottom: 1 }] as never);
    expect(post).toHaveBeenCalledWith(
      { action: "setFrustum", payload: [{ left: 0, top: 0, right: 1, bottom: 1 }] },
      [],
    );
  });

  it("forwards the transfer list", () => {
    const post = vi.spyOn(adapter, "postMessage");
    const buffer = new ArrayBuffer(8);
    adapter.call("setup" as never, [] as never, [buffer]);
    expect(post).toHaveBeenCalledWith({ action: "setup", payload: [] }, [buffer]);
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
