import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { type CallContext, contextPermissions } from "../core/context.js";
import { executionError } from "../core/execution.js";
import { GatewayFailure, success, unwrap } from "../core/protocol.js";
import type { GatewayHost, OwnerHandle } from "../core/registry.js";
import {
  CLEANUP_MS,
  type Command,
  Connection,
  HANDSHAKE_MS,
  parseManifest,
  responseBytes,
  StreamLink,
  unavailable,
} from "../worker/protocol.js";

/** Takes ownership of a dedicated Worker, including failed initialization and final termination. */
export async function attachWorker(host: GatewayHost, name: string, worker: Worker) {
  const contexts = new Map<string, CallContext>();
  let owner: OwnerHandle | undefined;
  let ready = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let exited = false;
  const cleanup = (reason = unavailable()) => {
    if (closed) return;
    closed = true;
    ready = false;
    streams.close(reason);
    contexts.clear();
    owner?.close(reason.detail);
  };
  const close = () => {
    if (closing) return closing;
    // Set the shared promise before owner.close can re-enter through onClose.
    closing = Promise.resolve().then(async () => {
      cleanup();
      try {
        if (!exited) await connection.request({ op: "close" }, CLEANUP_MS);
      } finally {
        if (!exited) await worker.terminate();
        connection.close();
        worker.off("error", failed);
        worker.off("exit", exit);
      }
    });
    ready = false;
    return closing;
  };
  const failed = () => {
    connection.close();
    cleanup();
    void close().catch(() => {});
  };
  const exit = () => {
    exited = true;
    failed();
  };
  const callback = async (command: Command, accept: (timeoutMs: number) => void): Promise<unknown> => {
    if (!ready || closed) throw unavailable();
    if (command.op === "stream.next" || command.op === "stream.cancel") return streams.control(command);
    if (command.op !== "invoke" && command.op !== "stream.open")
      throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "unsupported worker callback" });
    // Only the host owns permissions. A callback cannot authenticate itself with cloned metadata.
    const context = contexts.get(command.context.token);
    if (!context || command.context.permissions !== undefined)
      throw new GatewayFailure({ code: "UNAUTHORIZED", message: "unknown worker context token" });
    if (
      (command.op === "invoke" && command.route.kind !== "unary") ||
      (command.op === "stream.open" && command.route.kind !== "serverStreaming")
    )
      throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "worker operation does not match route kind" });
    const policy = host.executionPolicy(context, command.route);
    accept(command.op === "invoke" ? policy.timeoutMs : policy.streamPolicy.openTimeoutMs);
    if (command.op === "invoke") return unwrap(await host.invoke(context, command.route, command.payload));
    return streams.serve(command, (signal) => host.stream(context, command.route, command.payload, { signal }));
  };
  const connection = new Connection(worker, randomUUID(), callback);
  const streams = new StreamLink(connection);
  connection.onClose = (reason) => {
    cleanup(reason);
    void close().catch(() => {});
  };
  worker.on("error", failed);
  worker.on("exit", exit);
  let reservation: ReturnType<GatewayHost["reserveOwner"]> | undefined;
  try {
    const manifest = parseManifest(await connection.request({ op: "hello" }, HANDSHAKE_MS));
    const metadata = (context: CallContext) => {
      if (!ready || closed) throw unavailable();
      const token = `context:${randomUUID()}`;
      contexts.set(token, context);
      return { token, permissions: contextPermissions(context) };
    };
    reservation = host.reserveOwner(
      name,
      manifest.routes.map((route) => ({
        route,
        timeoutMs: route.timeoutMs,
        maxConcurrency: route.maxConcurrency,
        streamPolicy: route.streamPolicy,
      })),
      [],
      async (route, payload, context) => {
        const meta = metadata(context);
        try {
          return success(
            responseBytes(await connection.request({ op: "invoke", route, payload, context: meta }, HANDSHAKE_MS)),
          );
        } catch (error) {
          return executionError(error);
        } finally {
          contexts.delete(meta.token);
        }
      },
      async (route, payload, context, options) => {
        const meta = metadata(context);
        return streams.open(route, payload, meta, options, () => {
          contexts.delete(meta.token);
        });
      },
    );
    await connection.request({ op: "activate" }, HANDSHAKE_MS);
    ready = true;
    owner = reservation.publish();
    owner.onClose(() => {
      void close().catch(() => {});
    });
    return Object.freeze({ instance: owner.instance, manifest: owner.manifest, close });
  } catch (error) {
    reservation?.close();
    try {
      await close();
    } catch {
      /* Preserve the initialization failure. */
    }
    throw error;
  }
}
