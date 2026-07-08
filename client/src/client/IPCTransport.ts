import { JSONRPCClient, JSONRPCResponse as Response } from "json-rpc-2.0";
import { NameMethodMap } from "protocol";
import { Request, RequestOf, ResponseOf } from "protocol/Message";
import { IPCWorker } from "workers";
import { EventEmitter } from "./EventEmitter";
import { Transport, TransportEvents, TransportOptions } from "./Transport";

/** How long `connect()` waits for the worker's `ready` handshake before failing. */
const CONNECT_TIMEOUT_MS = 15_000;

export class IPCTransport extends EventEmitter<TransportEvents> implements Transport {
  worker: IPCWorker;
  rpc: JSONRPCClient;

  constructor(readonly options: TransportOptions) {
    super();
    this.worker = new IPCWorker();
    // One persistent message router instead of an add/remove listener per
    // request: the old per-request listener was only removed when a matching
    // response arrived, so a crash (no response) both leaked the listener and
    // left the request pending forever.
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onCrash);
    this.worker.addEventListener("messageerror", this.onCrash);
    this.rpc = new JSONRPCClient(async (request: Request) => {
      this.worker.postMessage(request);
    });
  }

  private onMessage = ({ data }: MessageEvent<Response | string>) => {
    // Response frames carry an `id`; the `ready` handshake string does not.
    if (data && typeof data === "object" && "id" in data) this.rpc.receive(data);
  };

  private onCrash = (e: Event) => {
    const message = (e as ErrorEvent).message || "IPC worker terminated unexpectedly";
    // Fail every in-flight call instead of leaving them pending forever.
    this.rpc.rejectAllPendingRequests(message);
  };

  connect() {
    this.worker.postMessage(this.options.url);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.worker.removeEventListener("message", onReady);
        this.worker.removeEventListener("error", onError);
        clearTimeout(timer);
      };
      const onReady = ({ data }: MessageEvent) => {
        if (data === "ready") {
          cleanup();
          resolve();
        }
      };
      const onError = (e: Event) => {
        cleanup();
        reject(new Error((e as ErrorEvent).message || "IPC worker crashed while connecting"));
      };
      // A dead-on-arrival worker never sends `ready`; bound the handshake so
      // `connect()` rejects instead of hanging. This bounds STARTUP only, never
      // the duration of any actual call.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`IPC worker did not become ready within ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      this.worker.addEventListener("message", onReady);
      this.worker.addEventListener("error", onError);
    });
  }

  async disconnect() {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onCrash);
    this.worker.removeEventListener("messageerror", this.onCrash);
    this.rpc.rejectAllPendingRequests("IPC worker disconnected");
    this.worker.terminate();
  }

  async call<T extends keyof NameMethodMap>(
    name: T,
    params?: RequestOf<NameMethodMap[T]>["params"],
  ): Promise<ResponseOf<NameMethodMap[T]>["result"]> {
    return await this.rpc.request(name, params);
  }
}
