import type { MessagePort, Worker } from "node:worker_threads";
import type { Permissions } from "../core/context.js";
import { executionError } from "../core/execution.js";
import {
  failure,
  type GatewayError,
  GatewayFailure,
  type Manifest,
  type Result,
  type Route,
  success,
  validateRoute,
} from "../core/protocol.js";
import {
  decodeFrame,
  encodeFrame,
  type ResponseStream,
  type StreamOptions,
  type StreamPolicy,
  streamPolicy,
} from "../core/stream.js";

export const CONTROL_LIMIT = 256;
export const HANDSHAKE_MS = 5000;
export const CLEANUP_MS = 1500;
const MAX_BYTES = 64 * 1024 * 1024;
export const unavailable = () => new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "worker connection closed" });
export interface Metadata {
  token: string;
  permissions?: Readonly<Permissions>;
}
export type Command =
  | { op: "hello" }
  | { op: "activate" }
  | { op: "close" }
  | { op: "invoke"; route: Route; payload: Uint8Array; context: Metadata }
  | { op: "stream.open"; stream: string; route: Route; payload: Uint8Array; context: Metadata }
  | { op: "stream.next"; stream: string; token: string }
  | { op: "stream.cancel"; stream: string; token: string };
type Frame =
  | { version: 1; generation: string; id: number; kind: "request"; command: Command }
  | { version: 1; generation: string; id: number; kind: "response"; result: Result<unknown> }
  | { version: 1; generation: string; id: number; kind: "accepted"; timeoutMs: number }
  | { version: 1; generation: string; kind: "terminal"; stream: string; result: Result<Uint8Array> };
type Port = Pick<MessagePort | Worker, "postMessage" | "on" | "off">;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const bytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.byteLength <= MAX_BYTES;
const codes = new Set([
  "CANCELLED",
  "RESOURCE_EXHAUSTED",
  "UNKNOWN_ROUTE",
  "OWNER_UNAVAILABLE",
  "INVALID_ARGUMENT",
  "CONCURRENCY_FULL",
  "TIMEOUT",
  "UNAUTHORIZED",
  "HANDLER_ERROR",
  "CONFLICT",
  "INCOMPATIBLE",
  "WRONG_METHOD_KIND",
]);
function result(v: unknown): v is Result<unknown> {
  return (
    object(v) &&
    (v.ok === true ||
      (v.ok === false && object(v.error) && codes.has(String(v.error.code)) && typeof v.error.message === "string"))
  );
}
function command(v: unknown): v is Command {
  if (!object(v)) return false;
  if (v.op === "hello" || v.op === "activate" || v.op === "close") return true;
  if (v.op === "stream.next" || v.op === "stream.cancel") return string(v.stream) && string(v.token);
  if (v.op !== "invoke" && v.op !== "stream.open") return false;
  if (v.op === "stream.open" && !string(v.stream)) return false;
  if (!bytes(v.payload) || !object(v.context) || !string(v.context.token) || !object(v.route)) return false;
  try {
    validateRoute(v.route as unknown as Route);
  } catch {
    return false;
  }
  return true;
}
function frame(v: unknown): v is Frame {
  if (!object(v) || v.version !== 1 || !string(v.generation)) return false;
  if (v.kind === "terminal") return string(v.stream) && result(v.result) && (!v.result.ok || bytes(v.result.value));
  if (!Number.isSafeInteger(v.id) || (v.id as number) < 1) return false;
  if (v.kind === "accepted")
    return Number.isSafeInteger(v.timeoutMs) && (v.timeoutMs as number) > 0 && (v.timeoutMs as number) <= 2_147_483_647;
  return v.kind === "request" ? command(v.command) : v.kind === "response" && result(v.result);
}
export function parseManifest(value: unknown): Manifest {
  if (!object(value) || !Array.isArray(value.routes) || !Array.isArray(value.events) || value.routes.length > 4096)
    throw new GatewayFailure({ code: "INCOMPATIBLE", message: "invalid worker manifest" });
  if (value.events.length)
    throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "worker events unsupported" });
  for (const route of value.routes) {
    if (!object(route)) throw new GatewayFailure({ code: "INCOMPATIBLE", message: "invalid worker route" });
    validateRoute(route as unknown as Route);
  }
  return value as unknown as Manifest;
}

/** Dedicated, bounded bidirectional MessagePort RPC. Cleanup bypasses the business request budget. */
export class Connection {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      finish: (result: Result<unknown>) => void;
      accept: (timeoutMs: number) => void;
    }
  >();
  private receiving = 0;
  private controls = 0;
  private ended = false;
  onTerminal: (stream: string, result: Result<Uint8Array>) => void = () => {};
  onClose: (reason: GatewayFailure) => void = () => {};

  constructor(
    private port: Port,
    private generation: string | undefined,
    private handler: (command: Command, accept: (timeoutMs: number) => void) => Promise<unknown>,
  ) {
    port.on("message", this.receive);
    port.on("messageerror", this.messageError);
  }

  private messageError = () =>
    this.close(new GatewayFailure({ code: "INCOMPATIBLE", message: "unreadable worker frame" }));
  private receive = (value: unknown) => {
    if (this.ended) return;
    if (!frame(value)) {
      this.close(new GatewayFailure({ code: "INCOMPATIBLE", message: "invalid worker frame" }));
      return;
    }
    if (!this.generation && value.kind === "request" && value.command.op === "hello")
      this.generation = value.generation;
    if (value.generation !== this.generation) return;
    if (value.kind === "accepted") {
      this.pending.get(value.id)?.accept(value.timeoutMs);
      return;
    }
    if (value.kind === "response") {
      this.pending.get(value.id)?.finish(value.result);
      return;
    }
    if (value.kind === "terminal") {
      this.onTerminal(value.stream, value.result);
      return;
    }
    const control = value.command.op === "close" || value.command.op === "stream.cancel";
    if ((control ? this.controls : this.receiving) >= (control ? 32 : CONTROL_LIMIT)) {
      this.send({ ...value, kind: "response", result: failure("RESOURCE_EXHAUSTED", "worker control table full") });
      return;
    }
    if (control) this.controls++;
    else this.receiving++;
    const respond = (result: Result<unknown>) => {
      if (control) this.controls--;
      else this.receiving--;
      this.send({ version: 1, generation: value.generation, kind: "response", id: value.id, result });
    };
    let accepted = false;
    const accept = (timeoutMs: number) => {
      if (accepted || (value.command.op !== "invoke" && value.command.op !== "stream.open")) return;
      accepted = true;
      this.send({ version: 1, generation: value.generation, kind: "accepted", id: value.id, timeoutMs });
    };
    // The handler runs immediately: stream.open installs cancellation before any await.
    try {
      void this.handler(value.command, accept).then(
        (value) => respond(success(value)),
        (e) => respond(executionError(e)),
      );
    } catch (error) {
      respond(executionError(error));
    }
  };

  private send(frame: Frame) {
    if (this.ended) return;
    try {
      this.port.postMessage(frame, []);
    } catch {
      this.close(unavailable());
    }
  }

  request(command: Command, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.ended || !this.generation) return Promise.reject(unavailable());
    if ((command.op === "invoke" || command.op === "stream.open") && command.payload.byteLength > MAX_BYTES)
      return Promise.reject(new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "worker payload too large" }));
    const control = command.op === "close" || command.op === "stream.cancel";
    if (this.pending.size >= CONTROL_LIMIT + (control ? 32 : 0))
      return Promise.reject(new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "worker pending table full" }));
    if (signal?.aborted) return Promise.reject(signal.reason ?? unavailable());
    const id = ++this.sequence;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const abort = () => finish(executionError(signal?.reason ?? unavailable()));
      let timer = setTimeout(() => finish(failure("TIMEOUT", "worker transport timed out")), timeoutMs);
      let accepted = false;
      const accept = (executionMs: number) => {
        if (accepted || (command.op !== "invoke" && command.op !== "stream.open")) return;
        accepted = true;
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(failure("TIMEOUT", "worker transport timed out")),
          Math.min(executionMs + 1000, 2_147_483_647),
        );
      };
      const finish = (result: Result<unknown>) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (result.ok) resolve(result.value);
        else reject(new GatewayFailure(result.error));
      };
      this.pending.set(id, { finish, accept });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ version: 1, generation, id, kind: "request", command });
    });
  }

  terminal(stream: string, result: Result<Uint8Array>) {
    if (this.generation) this.send({ version: 1, generation: this.generation, kind: "terminal", stream, result });
  }

  close(reason = unavailable()) {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.finish({ ok: false, error: reason.detail });
    this.port.off("message", this.receive);
    this.port.off("messageerror", this.messageError);
    this.onClose(reason);
  }
}

export function responseBytes(value: unknown, maxBytes = MAX_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    throw new GatewayFailure({ code: "INCOMPATIBLE", message: "invalid worker PB response" });
  return value;
}

/** Pull reader state is communication state, never a second producer/admission state machine. */
export class StreamLink {
  private sequence = 0;
  private readers = new Map<string, (result: Result<Uint8Array>) => void>();
  private served = new Map<
    string,
    {
      token: string;
      controller: AbortController;
      stream?: ResponseStream<Uint8Array>;
      seq: number;
    }
  >();

  constructor(private connection: Connection) {
    connection.onTerminal = (id, result) => this.readers.get(id)?.(result);
  }

  async open(route: Route, payload: Uint8Array, context: Metadata, options: StreamOptions = {}, release = () => {}) {
    const id = `stream:${++this.sequence}`;
    const controller = new AbortController();
    let terminal: GatewayError | "end" | undefined;
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let cancellation: Promise<void> | undefined;
    let busy = false;
    let seq = 0;
    const finish = (result: Result<Uint8Array>) => {
      if (terminal) return;
      if (result.ok && !(result.value.length === 1 && result.value[0] === 0)) {
        result = failure("INCOMPATIBLE", "invalid worker terminal frame");
      }
      terminal = result.ok ? "end" : result.error;
      this.readers.delete(id);
      options.signal?.removeEventListener("abort", abort);
      controller.abort(
        terminal === "end"
          ? new GatewayFailure({ code: "CANCELLED", message: "stream ended" })
          : new GatewayFailure(terminal),
      );
      settle();
      release();
    };
    const cancel = () => {
      cancellation ??= this.connection
        .request({ op: "stream.cancel", stream: id, token: context.token }, CLEANUP_MS)
        .then(() => {});
      void cancellation.catch(() => {});
      return cancellation;
    };
    const abort = () => {
      finish(
        executionError(
          options.signal?.reason instanceof GatewayFailure
            ? options.signal.reason
            : new GatewayFailure({ code: "CANCELLED", message: "stream cancelled" }),
        ),
      );
      void cancel();
    };
    this.readers.set(id, finish);
    options.signal?.addEventListener("abort", abort, { once: true });
    const opening = this.connection.request(
      { op: "stream.open", stream: id, route, payload, context },
      HANDSHAKE_MS,
      controller.signal,
    );
    if (options.signal?.aborted) abort();
    let policy: StreamPolicy;
    try {
      const raw = await opening;
      if (!object(raw)) throw new GatewayFailure({ code: "INCOMPATIBLE", message: "invalid stream policy" });
      policy = streamPolicy(raw);
    } catch (error) {
      finish(executionError(error));
      void cancel();
      throw error;
    }
    const connection = this.connection;
    const stream: ResponseStream<Uint8Array> = {
      policy,
      closed,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (terminal === "end") return { done: true, value: undefined };
        if (terminal) throw new GatewayFailure(terminal);
        if (busy) throw new GatewayFailure({ code: "CONCURRENCY_FULL", message: "one pending next per stream" });
        busy = true;
        try {
          const value = responseBytes(
            await connection.request(
              { op: "stream.next", stream: id, token: context.token },
              Math.min(policy.producerIdleMs + 1000, 2_147_483_647),
              controller.signal,
            ),
            MAX_BYTES + 5,
          );
          const item = decodeFrame(value, seq++);
          if (!item.done && item.value.length > policy.maxChunkBytes)
            throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "chunk too large" });
          if (item.done) finish(success(Uint8Array.of(0)));
          return item;
        } catch (error) {
          if (terminal === "end") return { done: true, value: undefined };
          finish(executionError(error));
          void cancel();
          throw error;
        } finally {
          busy = false;
        }
      },
      async cancel() {
        abort();
        await cancel();
      },
      async return() {
        await this.cancel();
        return { done: true, value: undefined };
      },
    };
    return stream;
  }

  async serve(
    command: Extract<Command, { op: "stream.open" }>,
    open: (signal: AbortSignal) => Promise<ResponseStream<Uint8Array>>,
  ) {
    if (this.served.size >= CONTROL_LIMIT || this.served.has(command.stream))
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "worker streams full or duplicate" });
    const state = {
      token: command.context.token,
      controller: new AbortController(),
      stream: undefined as ResponseStream<Uint8Array> | undefined,
      seq: 0,
    };
    this.served.set(command.stream, state);
    try {
      const stream = await open(state.controller.signal);
      state.stream = stream;
      void stream.closed.then(async () => {
        if (this.served.get(command.stream) !== state) return;
        this.served.delete(command.stream);
        try {
          const item = await stream.next();
          this.connection.terminal(command.stream, success(encodeFrame(state.seq, item)));
        } catch (error) {
          this.connection.terminal(command.stream, executionError(error));
        }
      });
      return stream.policy;
    } catch (error) {
      if (this.served.get(command.stream) === state) this.served.delete(command.stream);
      throw error;
    }
  }

  async control(command: Extract<Command, { op: "stream.next" | "stream.cancel" }>) {
    const state = this.served.get(command.stream);
    if (!state) {
      if (command.op === "stream.cancel") return;
      throw unavailable();
    }
    if (state.token !== command.token)
      throw new GatewayFailure({ code: "UNAUTHORIZED", message: "stream token mismatch" });
    if (command.op === "stream.cancel") {
      state.controller.abort();
      await state.stream?.cancel();
      return;
    }
    if (!state.stream) throw unavailable();
    const item = await state.stream.next();
    return encodeFrame(state.seq++, item);
  }

  close(reason = unavailable()) {
    for (const finish of [...this.readers.values()]) finish({ ok: false, error: reason.detail });
    for (const state of this.served.values()) state.controller.abort(reason);
    this.served.clear();
  }
}
