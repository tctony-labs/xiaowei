import type { GatewayEndpoint as ClipboardEndpoint } from "../../../../crates/xiaowei-clipboard/napi/index.js";
import type { GatewayEndpoint as SearchEndpoint } from "../../../../crates/xiaowei-search/napi/index.js";
import type { NativeEndpoint } from "../../src/main/native.js";

// Compile against napi-rs output; transport types must remain structurally compatible.
export function generatedEndpoints(search: SearchEndpoint, clipboard: ClipboardEndpoint): NativeEndpoint[] {
  return [search, clipboard];
}
