import type { GatewayEndpoint as ClipboardEndpoint } from "../../../../crates/xiaowei-clipboard/napi/index.js";
import type { GatewayEndpoint as SearchEndpoint } from "../../../../crates/xiaowei-search/napi/index.js";
import type { RustNapiEndpoint } from "../../src/main/rust-napi.js";

// Compile against napi-rs output; transport types must remain structurally compatible.
export function generatedEndpoints(search: SearchEndpoint, clipboard: ClipboardEndpoint): RustNapiEndpoint[] {
  return [search, clipboard];
}
