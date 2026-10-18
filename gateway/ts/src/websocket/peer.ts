import { createClient } from "../core/client.js";
import { createContext } from "../core/context.js";
import { executionError } from "../core/execution.js";
import {
  CONTRACT_VERSION,
  CONTROL_VERSION,
  type EventSink,
  GatewayFailure,
  type Manifest,
  type Route,
  success,
  type Transport,
  unwrap,
  validateName,
  validateRoute,
} from "../core/protocol.js";
import type { GatewayHost } from "../core/registry.js";
import { type ResponseStream, type StreamOptions, streamPolicy } from "../core/stream.js";
import {
  decode,
  encode,
  type Frame,
  type Header,
  LIMIT,
  MAX_PAYLOAD,
  unavailable,
} from "./wire.js";

interface Exports {
  host: GatewayHost;
  manifest: Manifest;
}
export interface ConnectOptions {
  url: string;
  token: string;
  exports: Exports;
  signal?: AbortSignal;
  onClose?: (reason?: GatewayFailure) => void;
}
function manifest(value: Manifest | undefined): Manifest {
  if (
    !value ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.events) ||
    value.routes.length > 256 ||
    value.events.length > 256
  )
    throw unavailable();
  const names = new Set<string>();
  for (const route of value.routes) {
    validateRoute(route);
    if (
      names.has(route.name) ||
      !Number.isSafeInteger(route.timeoutMs) ||
      route.timeoutMs < 1 ||
      route.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(route.maxConcurrency) ||
      route.maxConcurrency < 1
    )
      throw unavailable();
    names.add(route.name);
    if (route.streamPolicy) streamPolicy(route.streamPolicy);
  }
  names.clear();
  for (const event of value.events) {
    validateName(event.name);
    if (names.has(event.name) || !["ordered", "coalesce", "drop"].includes(event.policy))
      throw unavailable();
    names.add(event.name);
  }
  return value;
}

/** A network-scoped client. Remote routes never replace or fall back from local routes. */
export class WebSocketPeer {
  readonly client;
  private sequence = 0;
  private ended = false;
  private pending = new Map<string, { finish(frame?: Frame): void }>();
  private serving = new Map<string, AbortController>();
  private subscriptions = new Map<string, { close(): void }>();
  private sinks = new Map<string, EventSink>();
  private streams = new Map<string, ResponseStream<Uint8Array>>();
  private streamControllers = new Map<string, AbortController>();
  private readers = new Map<string, (error?: GatewayFailure) => void>();
  private context;
  private receiving = 0;
  private controls = 0;

  constructor(
    private socket: WebSocket,
    readonly generation: string,
    readonly manifest: Manifest,
    private exports: Exports,
    private onClose: (reason?: GatewayFailure) => void = () => {},
  ) {
    this.context = createContext({
      caller: `ws:${generation}`,
      trusted: false,
      invoke: exports.manifest.routes.map((r) => r.name),
      subscribe: exports.manifest.events.map((e) => e.name),
    });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.receive);
    socket.addEventListener("close", this.closed);
    socket.addEventListener("error", this.closed);
    const transport: Transport = {
      invoke: async (route, payload, signal, options) => {
        try {
          const actual = this.remoteRoute(route);
          return success(
            (
              await this.request(
                { op: "invoke", route },
                payload,
                signal,
                options,
                Math.min(actual.timeoutMs + 1000, 2_147_483_647),
              )
            ).payload,
          );
        } catch (error) {
          return executionError(error);
        }
      },
      stream: (route, payload, options) => this.openStream(route, payload, options),
      subscribe: (event, filter, sink) => this.subscribe(event, filter, sink),
    };
    this.client = createClient(transport);
  }

  /** Whether this live connection exports a compatible route, without sending a request. */
  canInvoke(route: Route): boolean {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.remoteRoute(route);
      return true;
    } catch {
      return false;
    }
  }

  private remoteRoute(route: Route) {
    validateRoute(route);
    const actual = this.manifest.routes.find((r) => r.name === route.name);
    if (!actual)
      throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "remote route not exported" });
    if (
      ["name", "kind", "input", "output", "controlVersion", "contractVersion"].some(
        (key) => actual[key as keyof Route] !== route[key as keyof Route],
      )
    )
      throw new GatewayFailure({ code: "INCOMPATIBLE", message: "remote route contract mismatch" });
    return actual;
  }

  private send(header: Header, payload?: Uint8Array, options?: Uint8Array) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw unavailable();
    const bytes = encode(header, payload, options);
    if (this.socket.bufferedAmount + bytes.length > 2 * MAX_PAYLOAD) {
      this.close();
      throw new GatewayFailure({
        code: "RESOURCE_EXHAUSTED",
        message: "WebSocket send buffer full",
      });
    }
    this.socket.send(bytes);
  }

  private request(
    fields: Omit<Header, "v" | "generation" | "id">,
    payload?: Uint8Array,
    signal?: AbortSignal,
    options?: Uint8Array,
    timeoutMs = 30_000,
    id = `c:${++this.sequence}`,
  ): Promise<Frame> {
    const control = ["cancel", "stream.cancel", "unsubscribe", "ping"].includes(fields.op);
    if (this.ended) return Promise.reject(unavailable());
    if (this.pending.size >= LIMIT + (control ? 32 : 0))
      return Promise.reject(
        new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "WebSocket requests full" }),
      );
    if (signal?.aborted)
      return Promise.reject(
        new GatewayFailure({ code: "CANCELLED", message: "request cancelled" }),
      );
    return new Promise((resolve, reject) => {
      const abort = () => {
        finish(
          undefined,
          signal?.reason instanceof GatewayFailure
            ? signal.reason
            : new GatewayFailure({ code: "CANCELLED", message: "request cancelled" }),
        );
        void this.request(
          { op: "cancel", target: id },
          undefined,
          undefined,
          undefined,
          1500,
        ).catch(() => {});
      };
      const timer = setTimeout(() => {
        finish(
          undefined,
          new GatewayFailure({ code: "TIMEOUT", message: "WebSocket request timed out" }),
        );
        if (!control)
          void this.request(
            { op: "cancel", target: id },
            undefined,
            undefined,
            undefined,
            1500,
          ).catch(() => {});
      }, timeoutMs);
      const finish = (frame?: Frame, error?: GatewayFailure) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (!frame) reject(unavailable());
        else if (frame.header.error) reject(new GatewayFailure(frame.header.error));
        else resolve(frame);
      };
      this.pending.set(id, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ v: 1, generation: this.generation, ...fields, id }, payload, options);
      } catch (error) {
        finish(undefined, error instanceof GatewayFailure ? error : unavailable());
      }
      if (signal?.aborted) abort();
    });
  }

  private receive = (event: MessageEvent) => {
    let frame: Frame;
    try {
      frame = decode(event.data);
    } catch {
      this.close();
      return;
    }
    const h = frame.header;
    if (h.generation !== this.generation) {
      this.close();
      return;
    }
    if (h.op === "connection.end") {
      this.close(h.error ? new GatewayFailure(h.error) : unavailable());
      return;
    }
    if (h.op === "result") {
      if (h.id) this.pending.get(h.id)?.finish(frame);
      return;
    }
    if (h.op === "stream.end") {
      if (h.target) this.readers.get(h.target)?.(h.error ? new GatewayFailure(h.error) : undefined);
      return;
    }
    if (!h.id?.startsWith("s:") || this.serving.has(h.id)) {
      this.close();
      return;
    }
    const control = ["cancel", "stream.cancel", "unsubscribe", "ping"].includes(h.op);
    if ((control ? this.controls : this.receiving) >= (control ? 32 : LIMIT)) {
      this.close();
      return;
    }
    if (control) this.controls++;
    else this.receiving++;
    const controller = new AbortController();
    this.serving.set(h.id, controller);
    const respond = (value: { payload?: Uint8Array; header?: Partial<Header> }) => {
      if (!this.ended)
        this.send(
          { v: 1, generation: this.generation, op: "result", id: h.id, ...value.header },
          value.payload,
        );
    };
    void this.serve(frame, controller.signal)
      .then(respond, (error) => {
        const result = executionError(error);
        if (!result.ok) respond({ header: { error: result.error } });
      })
      .catch(() => this.close())
      .finally(() => {
        this.serving.delete(h.id ?? "");
        if (control) this.controls--;
        else this.receiving--;
      });
  };

  private async serve(
    { header: h, payload, options }: Frame,
    signal: AbortSignal,
  ): Promise<{ payload?: Uint8Array; header?: Partial<Header> }> {
    if (h.op === "ping") return {};
    if (h.op === "cancel") {
      this.serving.get(h.target ?? "")?.abort();
      return {};
    }
    if (h.op === "event") {
      await this.sinks.get(h.target ?? "")?.(payload);
      return {};
    }
    if (h.op === "unsubscribe") {
      this.subscriptions.get(h.target ?? "")?.close();
      this.subscriptions.delete(h.target ?? "");
      return {};
    }
    if (h.op === "subscribe") {
      if (
        !h.event ||
        !this.exports.manifest.events.some((e) => e.name === h.event) ||
        this.subscriptions.size >= LIMIT
      )
        throw unavailable();
      const subscription = await this.exports.host.subscribe(
        this.context,
        h.event,
        payload.length ? payload : undefined,
        async (bytes) => {
          await this.request({ op: "event", target: h.id }, bytes);
        },
        false,
        { items: 16, bytes: 4 * 1024 * 1024, overflow: () => this.close() },
      );
      if (this.ended || signal.aborted) subscription.close();
      else this.subscriptions.set(h.id ?? "", subscription);
      return {};
    }
    if (h.op === "stream.cancel") {
      const id = h.target ?? "";
      this.streamControllers.get(id)?.abort();
      await this.streams.get(id)?.cancel();
      return {};
    }
    if (h.op === "stream.next") {
      const stream = this.streams.get(h.target ?? "");
      if (!stream) throw unavailable();
      const item = await stream.next();
      return { header: { done: !!item.done }, payload: item.done ? undefined : item.value };
    }
    if (
      (h.op !== "invoke" && h.op !== "stream.open") ||
      !h.route ||
      !this.exports.manifest.routes.some((r) => r.name === h.route?.name)
    )
      throw new GatewayFailure({ code: "UNAUTHORIZED", message: "route not exported to network" });
    if ((h.op === "invoke") !== (h.route.kind === "unary"))
      throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "wrong WebSocket operation" });
    if (h.op === "invoke")
      return {
        payload: unwrap(
          await this.exports.host.invoke(this.context, h.route, payload, signal, options),
        ),
      };
    if (this.streamControllers.size >= LIMIT) throw unavailable();
    const id = h.id ?? "";
    const controller = new AbortController();
    this.streamControllers.set(id, controller);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const stream = await this.exports.host.stream(this.context, h.route, payload, {
        signal: controller.signal,
      });
      this.streams.set(id, stream);
      void stream.closed
        .then(async () => {
          if (this.ended) return;
          try {
            const item = await stream.next();
            this.send({
              v: 1,
              generation: this.generation,
              op: "stream.end",
              target: id,
              done: !!item.done,
            });
          } catch (error) {
            const result = executionError(error);
            if (!result.ok)
              this.send({
                v: 1,
                generation: this.generation,
                op: "stream.end",
                target: id,
                error: result.error,
              });
          } finally {
            this.streams.delete(id);
            this.streamControllers.delete(id);
          }
        })
        .catch(() => this.close());
      return { header: { policy: stream.policy } };
    } catch (error) {
      this.streamControllers.delete(id);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async subscribe(event: string, filter: Uint8Array | undefined, sink: EventSink) {
    if (this.sinks.size >= LIMIT)
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "subscription table full" });
    if (!this.manifest.events.some((e) => e.name === event)) throw unavailable();
    const id = `c:${++this.sequence}`;
    this.sinks.set(id, sink);
    try {
      await this.request({ op: "subscribe", event }, filter, undefined, undefined, 5000, id);
    } catch (error) {
      this.sinks.delete(id);
      throw error;
    }
    return {
      close: () => {
        if (!this.sinks.delete(id) || this.ended) return;
        void this.request(
          { op: "unsubscribe", target: id },
          undefined,
          undefined,
          undefined,
          1500,
        ).catch(() => {});
      },
    };
  }

  private async openStream(route: Route, payload: Uint8Array, options: StreamOptions = {}) {
    const actual = this.remoteRoute(route);
    if (this.readers.size >= 32)
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "stream quota full" });
    if (route.kind !== "serverStreaming") throw unavailable();
    const id = `c:${++this.sequence}`;
    const controller = new AbortController();
    let terminal: GatewayFailure | "end" | undefined;
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let busy = false;
    const finish = (error?: GatewayFailure) => {
      if (terminal) return;
      terminal = error ?? "end";
      this.readers.delete(id);
      options.signal?.removeEventListener("abort", abort);
      controller.abort(error ?? unavailable());
      settle();
    };
    const cancelRemote = () =>
      this.ended
        ? Promise.resolve()
        : this.request(
            { op: "stream.cancel", target: id },
            undefined,
            undefined,
            undefined,
            1500,
          ).then(() => {});
    const abort = () => {
      finish(new GatewayFailure({ code: "CANCELLED", message: "stream cancelled" }));
      void cancelRemote().catch(() => {});
    };
    this.readers.set(id, finish);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let policy: ReturnType<typeof streamPolicy>;
    try {
      const response = await this.request(
        { op: "stream.open", route },
        payload,
        controller.signal,
        undefined,
        Math.min((actual.streamPolicy?.openTimeoutMs ?? 10_000) + 1000, 2_147_483_647),
        id,
      );
      if (!response.header.policy) throw unavailable();
      policy = streamPolicy(response.header.policy);
    } catch (error) {
      finish(error instanceof GatewayFailure ? error : unavailable());
      void cancelRemote().catch(() => {});
      throw error;
    }
    const peer = this;
    const stream: ResponseStream<Uint8Array> = {
      policy,
      closed,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (terminal === "end") return { done: true, value: undefined };
        if (terminal) throw terminal;
        if (busy)
          throw new GatewayFailure({
            code: "CONCURRENCY_FULL",
            message: "one pending next per stream",
          });
        busy = true;
        try {
          const value = await peer.request(
            { op: "stream.next", target: id },
            undefined,
            controller.signal,
            undefined,
            Math.min(policy.producerIdleMs + 1000, 2_147_483_647),
          );
          if (value.header.done) {
            finish();
            return { done: true, value: undefined };
          }
          if (value.payload.length > policy.maxChunkBytes) throw unavailable();
          return { done: false, value: value.payload };
        } catch (error) {
          if (terminal === "end") return { done: true, value: undefined };
          finish(error instanceof GatewayFailure ? error : unavailable());
          void cancelRemote().catch(() => {});
          throw terminal === "end" ? unavailable() : (terminal ?? error);
        } finally {
          busy = false;
        }
      },
      async cancel() {
        abort();
        await cancelRemote();
      },
      async return() {
        await this.cancel();
        return { done: true, value: undefined };
      },
    };
    return stream;
  }

  ping() {
    return this.request({ op: "ping" }, undefined, undefined, undefined, 5000).then(() => {});
  }
  private closed = () => this.close();
  close(reason?: GatewayFailure) {
    if (this.ended) return;
    this.ended = true;
    this.socket.removeEventListener("message", this.receive);
    this.socket.removeEventListener("close", this.closed);
    this.socket.removeEventListener("error", this.closed);
    for (const pending of this.pending.values()) pending.finish();
    for (const controller of this.serving.values()) controller.abort();
    for (const controller of this.streamControllers.values()) controller.abort();
    for (const subscription of this.subscriptions.values()) subscription.close();
    for (const finish of [...this.readers.values()]) finish(unavailable());
    this.exports.host.cleanupCaller(`ws:${this.generation}`);
    this.sinks.clear();
    this.subscriptions.clear();
    this.streams.clear();
    this.streamControllers.clear();
    this.socket.close();
    this.onClose(reason);
  }
}

export function connectWebSocket(options: ConnectOptions): Promise<WebSocketPeer> {
  manifest(options.exports.manifest);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(options.url);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => fail(), 5000);
    const abort = () => fail();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("message", welcomed);
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
    };
    const fail = (reason?: unknown) => {
      cleanup();
      socket.close();
      reject(reason instanceof GatewayFailure ? reason : unavailable());
    };
    const opened = () =>
      socket.send(
        encode({
          v: 1,
          generation: "",
          op: "authenticate",
          token: options.token,
          manifest: options.exports.manifest,
        }),
      );
    const welcomed = (event: MessageEvent) => {
      try {
        const { header } = decode(event.data);
        if (header.error) throw new GatewayFailure(header.error);
        if (header.op !== "ready" || !header.generation) throw unavailable();
        const remote = manifest(header.manifest);
        if (
          remote.routes.some(
            (r) => r.controlVersion !== CONTROL_VERSION || r.contractVersion !== CONTRACT_VERSION,
          )
        )
          throw unavailable();
        cleanup();
        resolve(
          new WebSocketPeer(socket, header.generation, remote, options.exports, options.onClose),
        );
      } catch (error) {
        fail(error);
      }
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("message", welcomed);
    socket.addEventListener("close", fail);
    socket.addEventListener("error", fail);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
