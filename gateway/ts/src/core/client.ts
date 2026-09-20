import { type EventSink, GatewayFailure, type Route, type Transport, unwrap } from "./protocol.js";
import type { StreamOptions } from "./stream.js";

/** A caller receives only this capability; it cannot register owners or select caller metadata. */
export function createClient(transport: Transport) {
  return Object.freeze({
    stream(route: Route, payload: Uint8Array, options?: StreamOptions) {
      if (!transport.stream) throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "stream unsupported" });
      return transport.stream(route, payload, options);
    },
    async invoke(route: Route, payload: Uint8Array) {
      return unwrap(await transport.invoke(route, payload));
    },
    subscribe(event: string, filter: Uint8Array | undefined, sink: EventSink, persistent = false) {
      return transport.subscribe(event, filter, sink, persistent);
    },
  });
}
export type Client = ReturnType<typeof createClient>;
