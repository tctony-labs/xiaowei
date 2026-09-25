import type { MessagePort } from "node:worker_threads";
import { createClient } from "../core/client.js";
import { authorize, createContext, type Permissions } from "../core/context.js";
import { ExecutionScope, executionError } from "../core/execution.js";
import { accepts, GatewayFailure, type Manifest, unwrap, validateRoute } from "../core/protocol.js";
import type { Registration } from "../core/registry.js";
import { streamPolicy } from "../core/stream.js";
import {
  type Command,
  Connection,
  HANDSHAKE_MS,
  type Metadata,
  responseBytes,
  StreamLink,
  unavailable,
} from "./protocol.js";

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
    streams.close();
    closing = execution.drained();
    return closing;
  };
  const client = (context: Metadata) =>
    createClient({
      async invoke(route, payload) {
        try {
          const value = responseBytes(
            await connection.request({ op: "invoke", route, payload, context: { token: context.token } }, HANDSHAKE_MS),
          );
          return { ok: true, value };
        } catch (error) {
          return executionError(error);
        }
      },
      stream: (route, payload, options) => streams.open(route, payload, { token: context.token }, options),
      async subscribe() {
        throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "worker events unsupported" });
      },
    });
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
      accept(registration.timeoutMs);
      return unwrap(await execution.invoke(registration, owner, context, client(command.context), command.payload));
    }
    if (command.route.kind !== "serverStreaming" || registration.route.kind !== "serverStreaming")
      throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "not a streaming route" });
    accept(streamPolicy(registration.streamPolicy).openTimeoutMs);
    return streams.serve(command, (signal) =>
      execution.stream(registration, owner, context, client(command.context), command.payload, { signal }),
    );
  };
  const connection = new Connection(parentPort, undefined, handler);
  const streams = new StreamLink(connection);
  connection.onClose = () => {
    void close();
  };
  parentPort.on("close", () => connection.close());
  return Object.freeze({ close });
}
