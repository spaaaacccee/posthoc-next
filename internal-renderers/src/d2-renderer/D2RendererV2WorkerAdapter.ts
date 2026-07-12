import { D2RendererV2Worker, D2V2WorkerEvent, D2V2WorkerEvents } from "./D2RendererV2Worker";
import url from "./D2RendererV2.worker.ts?worker&url";

/** Thin `Worker` wrapper over the v2 render worker, mirroring D2RendererWorkerAdapter. */
export class D2RendererV2WorkerAdapter extends Worker {
  constructor() {
    super(url, { type: "module" });
  }
  call<T extends keyof D2RendererV2Worker>(
    action: T,
    payload: Parameters<Extract<D2RendererV2Worker[T], (...args: never[]) => unknown>>,
    transfer: Transferable[] = [],
  ) {
    return this.postMessage({ action, payload }, transfer);
  }
  on<T extends keyof D2V2WorkerEvents>(event: T, handler: (payload: D2V2WorkerEvents[T]) => void) {
    const f = (e: MessageEvent<D2V2WorkerEvent>) => {
      const { action, payload } = e.data;
      if (action === event) handler(payload as D2V2WorkerEvents[T]);
    };
    this.addEventListener("message", f);
    return () => this.removeEventListener("message", f);
  }
}
