import {
  create,
  type DescMessage,
  type DescMethodUnary,
  type DescService,
  fromBinary,
  type Message,
  type MessageShape,
  toBinary,
} from "@bufbuild/protobuf";
import type { Client } from "../core/client.js";
import type { EventExport } from "../core/event.js";
import { type Backpressure, CONTRACT_VERSION, CONTROL_VERSION, GatewayFailure, type Route } from "../core/protocol.js";
import type { Registration } from "../core/registry.js";

export function methodRoute(method: DescService["methods"][number]): Route {
  return {
    name: `${method.parent.typeName}.${method.name}`,
    kind: method.methodKind === "unary" ? "unary" : "serverStreaming",
    input: method.input.typeName,
    output: method.output.typeName,
    controlVersion: CONTROL_VERSION,
    contractVersion: CONTRACT_VERSION,
  };
}
type UnaryKey<S extends DescService> = {
  [K in keyof S["method"]]: S["method"][K] extends DescMethodUnary ? K : never;
}[keyof S["method"]];
export type ServiceClient<S extends DescService> = {
  [K in UnaryKey<S>]: (
    request: MessageShape<S["method"][K]["input"]>,
  ) => Promise<MessageShape<S["method"][K]["output"]>>;
};
export type ServiceHandlers<S extends DescService> = {
  [K in UnaryKey<S>]: (
    request: MessageShape<S["method"][K]["input"]>,
    client: Client,
  ) => MessageShape<S["method"][K]["output"]> | Promise<MessageShape<S["method"][K]["output"]>>;
};
export function bindClient<S extends DescService>(service: S, client: Client): ServiceClient<S> {
  const methods: Record<string, unknown> = {};
  for (const method of service.methods) {
    if (method.methodKind !== "unary") continue;
    methods[method.localName] = async (request: MessageShape<typeof method.input>) => {
      let bytes: Uint8Array;
      try {
        bytes = toBinary(method.input, request);
      } catch {
        throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid request protobuf" });
      }
      const result = await client.invoke(methodRoute(method), bytes);
      try {
        return fromBinary(method.output, result);
      } catch {
        throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid response protobuf" });
      }
    };
  }
  return Object.freeze(methods) as ServiceClient<S>;
}
export function bindHandlers<S extends DescService>(service: S, handlers: ServiceHandlers<S>): Registration[] {
  return service.methods.map((method) => {
    const route = methodRoute(method);
    if (method.methodKind !== "unary") {
      if (method.methodKind !== "server_streaming") {
        throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "client streaming is unsupported" });
      }
      return { route };
    }
    const handler = handlers[method.localName as UnaryKey<S>] as unknown as (
      request: Message,
      client: Client,
    ) => Message | Promise<Message>;
    if (!handler) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "missing unary handler" });
    return {
      route,
      handler: async (bytes, client) => {
        let request: MessageShape<typeof method.input>;
        try {
          request = fromBinary(method.input, bytes);
        } catch {
          throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid request protobuf" });
        }
        const response = await handler(request, client);
        try {
          return toBinary(method.output, response);
        } catch {
          throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid response protobuf" });
        }
      },
    };
  });
}
export function bindEvent<P extends DescMessage, F extends DescMessage>(
  payload: P,
  filter: F,
  policy: Backpressure,
  matches: (payload: MessageShape<P>, filter: MessageShape<F> | undefined) => boolean,
): EventExport {
  return {
    name: payload.typeName,
    policy,
    validate(bytes) {
      try {
        if (bytes !== undefined) fromBinary(filter, bytes);
      } catch {
        throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid event filter" });
      }
    },
    matches(bytes, filterBytes) {
      try {
        return matches(
          fromBinary(payload, bytes),
          filterBytes === undefined ? undefined : fromBinary(filter, filterBytes),
        );
      } catch {
        return false;
      }
    },
  };
}
export function parseId(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid uint64 ID" });
  const id = BigInt(value);
  if (id > 0xffffffffffffffffn)
    throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "uint64 ID out of range" });
  return id;
}
export { create };
