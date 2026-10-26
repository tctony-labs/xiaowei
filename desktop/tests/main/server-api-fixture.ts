import { create, toBinary } from "@bufbuild/protobuf";
import { AuthenticatedSchema } from "proto-desktop-ts";
import type { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi, type RustNapiEndpoint } from "xiaowei-gateway/rust-napi";
import { XwAccount } from "xiaowei-rust";

export interface ServerApiContext {
  server: string;
  session?: {
    server: string;
    sessionId: string;
    accessToken: string;
    accessExpiresAtMs: bigint;
  };
}

// Configure a real composed native endpoint with each test's explicit target and clock.
// Product callers use the Rust-owned current context; these overrides exercise invalid inputs.
export async function attachServerApiFixture(
  host: GatewayHost,
  read: () => ServerApiContext,
  now: () => number = Date.now,
) {
  const native = new XwAccount();
  const endpoint = native.createGatewayEndpoint();
  const serialize = () => {
    const context = read();
    return {
      server: context.server,
      sessionServer: context.session?.server,
      authenticated:
        context.session &&
        Array.from(
          toBinary(AuthenticatedSchema, create(AuthenticatedSchema, { tokens: context.session })),
        ),
      nowMs: now(),
    };
  };
  const adapter: RustNapiEndpoint = {
    manifest: () => endpoint.manifest(),
    bind: (callback, context) => endpoint.bind(callback, context),
    activate: () => endpoint.activate(),
    rpcControl: (control, payload, context) =>
      endpoint.rpcControl(
        control,
        payload,
        JSON.stringify({ ...JSON.parse(context), accountSession: serialize() }),
      ),
    streamControl: (control, payload, context) => endpoint.streamControl(control, payload, context),
    dispatchLocal: (route, payload, context) => endpoint.dispatchLocal(route, payload, context),
    subscribeLocal: (id, event, filter, context) =>
      endpoint.subscribeLocal(id, event, filter, context),
    unsubscribeLocal: (id) => endpoint.unsubscribeLocal(id),
    deliver: (id, payload) => endpoint.deliver(id, payload),
    close: () => endpoint.close(),
  };
  return attachRustNapi(host, "server-api-fixture", adapter);
}
