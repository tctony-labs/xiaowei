import type { IpcRenderer } from "electron";
import { type Delivery, GATEWAY_CHANNEL, GATEWAY_EVENT, type GatewayBridge } from "../core/electron-protocol.js";
import { CONTROL_VERSION } from "../core/protocol.js";

export function createPreloadBridge(ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): GatewayBridge {
  const listeners = new Set<(id: string, payload: Uint8Array) => void>();
  let session = "";
  ipc.on(GATEWAY_EVENT, (_event, delivery: Delivery) => {
    if (delivery.session !== session) return;
    for (const listener of listeners) listener(delivery.id, delivery.payload);
  });
  const ready = ipc.invoke(GATEWAY_CHANNEL, { operation: "connect", version: CONTROL_VERSION }).then((value) => {
    if (typeof value !== "string" || !value) throw new Error("Gateway session unavailable");
    session = value;
    return value;
  });
  void ready.catch(() => {});
  const bridge: GatewayBridge = {
    async request(request) {
      return ipc.invoke(GATEWAY_CHANNEL, { ...request, version: CONTROL_VERSION, session: await ready });
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return Object.freeze(bridge);
}
