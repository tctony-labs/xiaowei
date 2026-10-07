import type { MessagePort } from "node:worker_threads";
import { createClient } from "../core/client.js";
import { authorize, type CallContext, createContext, type Permissions } from "../core/context.js";
import { ExecutionScope, executionError } from "../core/execution.js";
import { accepts, GatewayFailure, type Manifest, unwrap, validateRoute } from "../core/protocol.js";
import type { Registration } from "../core/registry.js";
import { streamPolicy } from "../core/stream.js";
import { type Command, Connection, type Metadata, RpcLink, StreamLink, unavailable } from "./protocol.js";

function permissions(metadata: Metadata): Permissions {
  const value = metadata.permissions;
  if (
    !value ||
    typeof value.caller !== "string" ||
    typeof value.trusted !== "boolean" ||
    (value.invoke !== undefined && (!Array.isArray(value.invoke) || value.invoke.some((v) => typeof v !== "string"))) ||
    (value.subscribe !== undefined &&
      (!Array.isArray(value.subscribe) || value.subscribe.some((v) => typeof v !== "string")))
  )
    throw new GatewayFailure({ code: "UNAUTHORIZED", message: "missing authenticated worker metadata" });
  return value;
}

/** Fixed local service endpoint, not a second routing host. Its clients always return through main. */
export function exposeWorkerEndpoint(parentPort: MessagePort, registrations: readonly Registration[]) {
  const entries = new Map<string, Registration & { timeoutMs: number; maxConcurrency: number }>();
  for (const registration of registrations) {
    validateRoute(registration.route);
    if (entries.has(registration.route.name))
      throw new GatewayFailure({ code: "CONFLICT", message: "duplicate worker route" });
    if (
      (registration.route.kind === "unary" && (!registration.handler || registration.streamHandler)) ||
      (registration.route.kind === "serverStreaming" && (!registration.streamHandler || registration.handler))
    )
      throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid worker handler kind" });
    const timeoutMs = registration.timeoutMs ?? 30_000;
    const maxConcurrency = registration.maxConcurrency ?? 32;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxConcurrency) ||
      maxConcurrency <= 0
    )
      throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid worker execution policy" });
    entries.set(
      registration.route.name,
      Object.freeze({
        ...registration,
        route: Object.freeze({ ...registration.route }),
        timeoutMs,
        maxConcurrency,
        streamPolicy: Object.freeze(streamPolicy(registration.streamPolicy)),
      }),
    );
  }
  const manifest: Manifest = {
    routes: [...entries.values()].map((r) => ({
      ...r.route,
      optionsSchema: r.optionsSchema,
      timeoutMs: r.timeoutMs,
      maxConcurrency: r.maxConcurrency,
      streamPolicy: r.streamPolicy,
    })),
    events: [],
  };
  const execution = new ExecutionScope();
  const owner = {};
  let active = false;
  let hello = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    active = false;
    execution.close(owner);
    rpcs.close();
    streams.close();
    closing = execution.drained();
    return closing;
  };
  const client = (context: Metadata, localContext: CallContext, signal: AbortSignal, serviceOptions?: Uint8Array) =>
    createClient(
      {
        async invoke(route, payload, signal, serviceOptions) {
          try {
            const value = await rpcs.invoke(route, payload, { token: context.token }, signal, serviceOptions);
            return { ok: true, value };
          } catch (error) {
            return executionError(error);
          }
        },
        stream: (route, payload, options) => streams.open(route, payload, { token: context.token }, options),
        async subscribe() {
          throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "worker events unsupported" });
        },
      },
      { context: localContext, signal, serviceOptions },
    );
  const handler = async (command: Command, accept: (timeoutMs: number) => void): Promise<unknown> => {
    if (command.op === "close") return close();
    if (closed) throw unavailable();
    if (command.op === "hello") {
      if (hello) throw new GatewayFailure({ code: "CONFLICT", message: "worker already bound" });
      hello = true;
      return manifest;
    }
    if (command.op === "activate") {
      if (!hello || active) throw unavailable();
      active = true;
      return;
    }
    if (!active) throw unavailable();
    if (command.op === "invoke.cancel") return rpcs.cancel(command);
    if (command.op === "stream.next" || command.op === "stream.cancel") return streams.control(command);
    const context = createContext(permissions(command.context));
    authorize(context, command.route.name);
    const registration = entries.get(command.route.name);
    if (!registration) throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "worker route not registered" });
    const compatible =
      command.op === "invoke"
        ? accepts(registration.route, command.route)
        : accepts({ ...registration.route, kind: "unary" }, { ...command.route, kind: "unary" });
    unwrap(compatible);
    if (command.op === "invoke") {
      if (command.serviceOptions !== undefined && !registration.optionsSchema)
        throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "service has no options" });
      accept(registration.timeoutMs);
      return rpcs.serve(command, async (signal) =>
        unwrap(
          await execution.invoke(
            registration,
            owner,
            context,
            (signal) => client(command.context, context, signal, command.serviceOptions),
            command.payload,
            signal,
          ),
        ),
      );
    }
    if (command.route.kind !== "serverStreaming" || registration.route.kind !== "serverStreaming")
      throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "not a streaming route" });
    accept(streamPolicy(registration.streamPolicy).openTimeoutMs);
    return streams.serve(command, (signal) =>
      execution.stream(
        registration,
        owner,
        context,
        (signal) => client(command.context, context, signal),
        command.payload,
        { signal },
      ),
    );
  };
  const connection = new Connection(parentPort, undefined, handler);
  const streams = new StreamLink(connection);
  const rpcs = new RpcLink(connection);
  connection.onClose = () => {
    void close();
  };
  parentPort.on("close", () => connection.close());
  return Object.freeze({ close });
}
