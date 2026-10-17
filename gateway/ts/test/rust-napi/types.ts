import type { GatewayEndpoint as AgentEndpoint } from "../../../../crates/xiaowei-agent/napi/index.js";
import type { GatewayEndpoint as BusinessEndpoint } from "../../../../crates/xiaowei-rust/napi/index.js";
import type { RustNapiEndpoint } from "../../src/main/rust-napi.js";

// Compile against napi-rs output; transport types must remain structurally compatible.
export function generatedEndpoints(
  business: BusinessEndpoint,
  agent: AgentEndpoint,
): RustNapiEndpoint[] {
  return [business, agent];
}
