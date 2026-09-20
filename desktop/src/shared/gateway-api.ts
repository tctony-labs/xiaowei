import type { GatewayBridge } from "xiaowei-gateway/renderer";

export type { GatewayBridge };

declare global {
  interface Window {
    gateway: GatewayBridge;
  }
}
