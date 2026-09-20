import type { Result, Route } from "./protocol.js";

export const GATEWAY_CHANNEL = "xiaowei:gateway";
export const GATEWAY_EVENT = "xiaowei:gateway:event";

export interface ElectronRequest {
  operation: "invoke" | "subscribe" | "unsubscribe" | "stream.open" | "stream.next" | "stream.cancel";
  id?: string;
  route?: Route;
  event?: string;
  payload?: Uint8Array;
  filter?: Uint8Array;
  persistent?: boolean;
}

export interface Delivery {
  session: string;
  id: string;
  payload: Uint8Array;
}

/** Only ordinary values/functions cross contextBridge. No iterator, signal, or ipcRenderer. */
export interface GatewayBridge {
  request(request: ElectronRequest): Promise<Result<Uint8Array>>;
  listen(listener: (id: string, payload: Uint8Array) => void): () => void;
}
