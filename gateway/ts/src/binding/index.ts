import {
  create,
  type DescMessage,
  type DescMethodServerStreaming,
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
import type { ResponseStream, StreamOptions } from "../core/stream.js";

export function methodRoute(method: DescService["methods"][number]): Route {
  if (method.methodKind !== "unary" && method.methodKind !== "server_streaming")
    throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "client streaming is unsupported" });
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
  for (const method of service.methods) methodRoute(method);
  return service.methods
    .filter((method) => method.methodKind === "unary")
    .map((method) => {
      const route = methodRoute(method);
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
type StreamKey<S extends DescService> = {
  [K in keyof S["method"]]: S["method"][K] extends DescMethodServerStreaming ? K : never;
}[keyof S["method"]];
export type StreamClient<S extends DescService> = {
  [K in StreamKey<S>]: (
    request: MessageShape<S["method"][K]["input"]>,
    options?: StreamOptions,
  ) => Promise<ResponseStream<MessageShape<S["method"][K]["output"]>>>;
};
export type StreamHandlers<S extends DescService> = {
  [K in StreamKey<S>]: (
    request: MessageShape<S["method"][K]["input"]>,
    client: Client,
    signal: AbortSignal,
  ) =>
    | AsyncIterable<MessageShape<S["method"][K]["output"]>>
    | Promise<AsyncIterable<MessageShape<S["method"][K]["output"]>>>;
};
export function bindStreamClient<S extends DescService>(service: S, client: Client): StreamClient<S> {
  const methods: Record<string, unknown> = {};
  for (const method of service.methods) {
    if (method.methodKind !== "server_streaming") continue;
    methods[method.localName] = async (request: MessageShape<typeof method.input>, options?: StreamOptions) => {
      const stream = await client.stream(methodRoute(method), toBinary(method.input, request), options);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        policy: stream.policy,
        closed: stream.closed,
        cancel: () => stream.cancel(),
        return: () => stream.return(),
        async next() {
          const item = await stream.next();
          if (item.done) return item;
          try {
            return { done: false, value: fromBinary(method.output, item.value) };
          } catch {
            await stream.cancel();
            throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid chunk PB" });
          }
        },
      };
    };
  }
  return Object.freeze(methods) as StreamClient<S>;
}
// Limit the single generated object before allocating its PB encoding. This does not
// allow handlers to buffer upstream objects; active sources use boundedByteQueue.
function checkChunkObject(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 65_536 || depth > 64)
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "chunk object too large" });
    if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (typeof value === "string") bytes += value.length * 3;
    else if (value && typeof value === "object") {
      for (const key in value) visit((value as Record<string, unknown>)[key], depth + 1);
    }
    if (bytes > 64 * 1024 * 1024)
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "chunk object too large" });
  };
  visit(value, 0);
}
export function bindStreamHandlers<S extends DescService>(service: S, handlers: StreamHandlers<S>): Registration[] {
  return service.methods
    .filter((m) => m.methodKind === "server_streaming")
    .map((method) => {
      const handler = handlers[method.localName as StreamKey<S>] as unknown as (
        request: Message,
        client: Client,
        signal: AbortSignal,
      ) => AsyncIterable<Message> | Promise<AsyncIterable<Message>>;
      if (!handler) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "missing stream handler" });
      return {
        route: methodRoute(method),
        async streamHandler(bytes, client, signal) {
          const source = await handler(fromBinary(method.input, bytes), client, signal);
          return {
            async *[Symbol.asyncIterator]() {
              for await (const chunk of source) {
                checkChunkObject(chunk);
                yield toBinary(method.output, chunk);
              }
            },
          };
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
