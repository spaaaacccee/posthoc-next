import { D2RendererV2Worker } from "./D2RendererV2Worker";

const instance = new D2RendererV2Worker();

instance.on("message", (m, t) => self.postMessage(m, t));

self.onmessage = (e: MessageEvent) => {
  const { action, payload } = e.data;
  ///@ts-ignore
  instance[action](...payload);
};
