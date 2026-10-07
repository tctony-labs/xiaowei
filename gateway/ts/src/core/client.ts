import { type DescMessage, fromBinary, type MessageShape } from "@bufbuild/protobuf";
import type { CallContext } from "./context.js";
import { type EventSink, GatewayFailure, type Route, type Transport, unwrap } from "./protocol.js";
import { createRpc } from "./rpc.js";
import type { StreamOptions } from "./stream.js";

/** A caller receives only this capability; it cannot register owners or select caller metadata. */
export function createClient(
  transport: Transport,
  options: { context?: CallContext; signal?: AbortSignal; serviceOptions?: Uint8Array } = {},
) {
  const context = options.context;
  const signal = options.signal ?? new AbortController().signal;
  return Object.freeze({
    context(): CallContext {
      if (!context) throw new GatewayFailure({ code: "UNAUTHORIZED", message: "client has no local handler context" });
      return context;
    },
    options<S extends DescMessage>(schema: S): MessageShape<S> | undefined {
      if (options.serviceOptions === undefined) return undefined;
      try {
        return fromBinary(schema, options.serviceOptions);
      } catch {
        throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid service options protobuf" });
      }
    },
    cancellation(): AbortSignal {
      return signal;
    },
    stream(route: Route, payload: Uint8Array, options?: StreamOptions) {
      if (!transport.stream) throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "stream unsupported" });
      return transport.stream(route, payload, { ...options, signal: options?.signal ?? signal });
    },
    invoke(route: Route, payload: Uint8Array, serviceOptions?: Uint8Array) {
      return createRpc(
        async (signal) => unwrap(await transport.invoke(route, payload, signal, serviceOptions)),
        signal,
      );
    },
    subscribe(event: string, filter: Uint8Array | undefined, sink: EventSink, persistent = false) {
      return transport.subscribe(event, filter, sink, persistent);
    },
  });
}
export type Client = ReturnType<typeof createClient>;
