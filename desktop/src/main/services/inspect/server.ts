import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  INSPECT_MAX_BYTES,
  INSPECT_PROTOCOL,
  INSPECT_TIMEOUT_MS,
  INSPECT_VERSION,
  InspectError,
  type InspectMethod,
  type InspectRequest,
  type InspectResponse,
  type InspectSource,
} from "./protocol.ts";
import { ensureInspectDirectory, inspectSocketPath, resolveInspectSource } from "./target.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRequest(value: unknown, source: InspectSource): InspectRequest {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.method !== "string" ||
    !isObject(value.params) ||
    Object.keys(value).some(
      (key) => !["protocol", "version", "id", "source", "method", "params"].includes(key),
    )
  ) {
    throw new InspectError("INVALID_REQUEST", "Expected id, method, source and object params");
  }
  if (value.protocol !== INSPECT_PROTOCOL || value.version !== INSPECT_VERSION) {
    throw new InspectError("VERSION_MISMATCH", `Expected inspect protocol ${INSPECT_VERSION}`);
  }
  if (
    !isObject(value.source) ||
    Object.keys(value.source).some((key) => !["kind", "path"].includes(key)) ||
    value.source.kind !== source.kind ||
    value.source.path !== source.path
  ) {
    throw new InspectError("SOURCE_MISMATCH", "Socket belongs to different application sources");
  }
  return value as unknown as InspectRequest;
}

function validateParams(method: InspectMethod, params: Record<string, unknown>): void {
  for (const name of Object.keys(params)) {
    if (!Object.hasOwn(method.params, name)) {
      throw new InspectError("INVALID_PARAMS", `Unknown parameter: ${name}`);
    }
  }
  for (const [name, schema] of Object.entries(method.params)) {
    const value = params[name];
    if (value === undefined && !schema.required) continue;
    if (
      typeof value !== schema.type ||
      (schema.values && !schema.values.includes(value as string))
    ) {
      throw new InspectError("INVALID_PARAMS", `Invalid parameter: ${name}`);
    }
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
    throw new Error(`Inspect path exists and is not an owned socket: ${path}`);
  }

  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(INSPECT_TIMEOUT_MS);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`Inspect socket is already serving an instance: ${path}`));
    });
    probe.once("timeout", () => {
      probe.destroy();
      reject(new Error(`Inspect socket liveness check timed out: ${path}`));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return;
  if (current.ino !== existing.ino || current.dev !== existing.dev) {
    throw new Error(`Inspect socket changed during liveness check: ${path}`);
  }
  await unlink(path);
}

export async function startInspectServer(options: {
  source: InspectSource;
  methods: ReadonlyMap<string, InspectMethod>;
  timeoutMs?: number;
}) {
  const source = await resolveInspectSource(options.source);
  const path = inspectSocketPath(source);
  await ensureInspectDirectory(dirname(path));
  await removeStaleSocket(path);
  const connections = new Set<Socket>();
  const timeoutMs = options.timeoutMs ?? INSPECT_TIMEOUT_MS;
  let closing: Promise<void> | undefined;
  let operations: Promise<unknown> = Promise.resolve();

  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => {});
    const deadline = Date.now() + timeoutMs;
    let received = Buffer.alloc(0);
    let handled = false;

    async function respond(value: unknown, failure?: InspectError): Promise<void> {
      const started = Date.now();
      const id = isObject(value) && typeof value.id === "string" ? value.id : "";
      const response: InspectResponse = {
        protocol: INSPECT_PROTOCOL,
        version: INSPECT_VERSION,
        source,
        id,
        ok: false,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (failure) throw failure;
        const request = validateRequest(value, source);
        const method = options.methods.get(request.method);
        if (!method) throw new InspectError("UNKNOWN_METHOD", "Unknown inspect method");
        validateParams(method, request.params);
        const run = () => {
          if (closing) throw new InspectError("APP_CLOSING", "Application is shutting down");
          if (Date.now() >= deadline) {
            throw new InspectError("TIMEOUT", "Inspect request expired before execution");
          }
          return method.run(request.params);
        };
        const result = method.mutates ? operations.then(run) : Promise.resolve().then(run);
        if (method.mutates) operations = result.catch(() => {});
        response.result = await Promise.race([
          result,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new InspectError("TIMEOUT", "Inspect timed out; action outcome is unconfirmed"),
                ),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
        response.ok = true;
        if (method.mutates) {
          console.debug("Inspect operation completed", {
            method: request.method,
            durationMs: Date.now() - started,
          });
        }
      } catch (error) {
        response.error = {
          code: error instanceof InspectError ? error.code : "HANDLER_ERROR",
          message: error instanceof Error ? error.message : "Inspect operation failed",
        };
        console.warn("Inspect request failed", {
          method:
            isObject(value) && typeof value.method === "string" && options.methods.has(value.method)
              ? value.method
              : undefined,
          code: response.error.code,
        });
      } finally {
        clearTimeout(timer);
      }
      if (socket.destroyed) return;
      let line = JSON.stringify(response);
      if (Buffer.byteLength(line) + 1 > INSPECT_MAX_BYTES) {
        line = JSON.stringify({
          ...response,
          ok: false,
          result: undefined,
          error: { code: "FRAME_TOO_LARGE", message: "Inspect response exceeds size limit" },
        });
      }
      socket.setTimeout(timeoutMs);
      socket.end(`${line}\n`);
    }

    const readTimer = setTimeout(() => {
      if (handled) return;
      handled = true;
      void respond(undefined, new InspectError("TIMEOUT", "Inspect request was not completed"));
    }, timeoutMs);
    socket.once("close", () => clearTimeout(readTimer));

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > INSPECT_MAX_BYTES) {
        handled = true;
        clearTimeout(readTimer);
        void respond(
          undefined,
          new InspectError("FRAME_TOO_LARGE", "Inspect request exceeds size limit"),
        );
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      handled = true;
      clearTimeout(readTimer);
      try {
        void respond(JSON.parse(received.subarray(0, newline).toString("utf8")));
      } catch {
        void respond(undefined, new InspectError("INVALID_JSON", "Invalid inspect JSON frame"));
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
  server.on("error", (error) => console.error("Inspect socket failed", error));
  console.info("Inspect socket listening", { source, path });

  return {
    source,
    path,
    close(): Promise<void> {
      closing ??= new Promise((resolve, reject) => {
        for (const socket of connections) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}
