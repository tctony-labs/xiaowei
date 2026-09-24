import { Buffer } from "node:buffer";
import { contextPermissions } from "../core/context.js";
import {
  CONTROL_VERSION,
  type EventSink,
  failure,
  GatewayFailure,
  type Manifest,
  type Result,
  type Route,
  type Subscription,
  success,
  unwrap,
} from "../core/protocol.js";
import {
  type CallContext,
  createContext,
  type GatewayHost,
  type OwnerHandle,
  type Permissions,
} from "../core/registry.js";
import { decodeFrame, encodeFrame, type ResponseStream } from "../core/stream.js";

/** Structurally implemented by each addon's generated GatewayEndpoint class. */
export interface RustNapiEndpoint {
  manifest(): string;
  bind(callback: (control: string, payload: Buffer) => Promise<Buffer | string>, context: string): void;
  activate(): Promise<Buffer | string>;
  streamControl(control: string, payload: Buffer, context: string): Promise<Buffer | string>;
  dispatchLocal(route: string, payload: Buffer, context: string): Promise<Buffer | string>;
  subscribeLocal(id: string, event: string, filter: Buffer | null, context: string): Promise<Buffer | string>;
  unsubscribeLocal(id: string): void;
  deliver(id: string, payload: Buffer): Promise<Buffer | string>;
  close(): Promise<Buffer | string>;
}
interface Control {
  version: number;
  operation:
    | "invoke"
    | "subscribe"
    | "unsubscribe"
    | "event"
    | "closed"
    | "stream.open"
    | "stream.next"
    | "stream.cancel";
  contextToken: string;
  route?: Route;
  event?: string;
  subscriptionId?: string;
  streamId?: string;
  filterPresent: boolean;
}
function decode(reply: Buffer | string): Result<Uint8Array> {
  if (reply instanceof Uint8Array) return success(reply);
  const error: unknown = JSON.parse(reply);
  if (!error || typeof error !== "object" || !("code" in error) || !("message" in error)) {
    return failure("HANDLER_ERROR", "invalid Rust napi response");
  }
  return { ok: false, error: error as GatewayFailure["detail"] };
}
function encode(result: Result<Uint8Array>): Buffer | string {
  return result.ok ? Buffer.from(result.value) : JSON.stringify(result.error);
}
const unavailable = () => new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "Rust napi endpoint unavailable" });

/** No business addon imports. The application supplies a freshly created endpoint. */
export async function attachRustNapi(
  host: GatewayHost,
  name: string,
  endpoint: RustNapiEndpoint,
  permissions: Permissions = { caller: name, trusted: true },
) {
  let manifest: Manifest & { controlVersion: number };
  try {
    manifest = JSON.parse(endpoint.manifest());
    if (manifest.controlVersion !== CONTROL_VERSION)
      throw new GatewayFailure({ code: "INCOMPATIBLE", message: "Rust napi control version mismatch" });
  } catch (error) {
    await endpoint.close();
    throw error;
  }
  const streams = new Map<
    string,
    {
      context: CallContext;
      token: string;
      controller: AbortController;
      stream?: ResponseStream<Uint8Array>;
      seq: number;
    }
  >();
  const contexts = new Map<string, CallContext>();
  const eventSinks = new Map<string, EventSink>();
  const subscriptions = new Map<string, Subscription>();
  const openingSubscriptions = new Set<string>();
  let nextId = 0;
  let owner: OwnerHandle | undefined;
  let closed = false;
  let ready = false;
  let closing: Promise<void> | undefined;
  const origin = createContext(permissions);
  const originToken = `origin:${name}`;
  contexts.set(originToken, origin);
  const contextJson = (token: string, context: CallContext) =>
    JSON.stringify({ token, ...contextPermissions(context) });
  const withContext = async <T>(context: CallContext, work: (metadata: string) => Promise<T>) => {
    const token = `call:${++nextId}`;
    contexts.set(token, context);
    try {
      return await work(contextJson(token, context));
    } finally {
      contexts.delete(token);
    }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    ready = false;
    for (const session of streams.values()) session.controller.abort();
    streams.clear();
    contexts.clear();
    eventSinks.clear();
    openingSubscriptions.clear();
    for (const subscription of subscriptions.values()) subscription.close();
    subscriptions.clear();
    owner?.close();
  };
  const close = async () => {
    cleanup();
    closing ??= endpoint.close().then((result) => {
      unwrap(decode(result));
    });
    await closing;
  };
  const events = manifest.events.map((event) => ({
    ...event,
    attach: async (context: CallContext, filter: Uint8Array | undefined, sink: EventSink): Promise<Subscription> => {
      if (!ready || closed) throw unavailable();
      const id = `event:${++nextId}`;
      eventSinks.set(id, sink);
      try {
        await withContext(context, async (metadata) =>
          unwrap(
            decode(
              await endpoint.subscribeLocal(
                id,
                event.name,
                filter === undefined ? null : Buffer.from(filter),
                metadata,
              ),
            ),
          ),
        );
        if (closed) throw unavailable();
      } catch (error) {
        eventSinks.delete(id);
        endpoint.unsubscribeLocal(id);
        throw error;
      }
      return {
        close() {
          eventSinks.delete(id);
          endpoint.unsubscribeLocal(id);
        },
      };
    },
  }));
  let reservation: ReturnType<GatewayHost["reserveOwner"]> | undefined;
  try {
    reservation = host.reserveOwner(
      name,
      manifest.routes.map((route) => ({
        route,
        timeoutMs: route.timeoutMs,
        maxConcurrency: route.maxConcurrency,
        streamPolicy: route.streamPolicy,
        streamHandler:
          route.kind !== "serverStreaming"
            ? undefined
            : async (payload, _client, signal, hostContext) => {
                if (!ready || closed) throw unavailable();
                const id = `stream:${++nextId}`;
                const token = `stream-context:${++nextId}`;
                // Context is bound by the host dispatcher below, never reconstructed from payload bytes.
                const context = hostContext;
                contexts.set(token, context);
                const metadata = contextJson(token, context);
                let seq = 0;
                let cancelled = false;
                let cancellation: Promise<void> = Promise.resolve();
                const control = (operation: string) =>
                  JSON.stringify({
                    version: CONTROL_VERSION,
                    operation,
                    streamId: id,
                    route,
                  });
                const cancel = () => {
                  if (cancelled) return cancellation;
                  cancelled = true;
                  signal.removeEventListener("abort", abortStream);
                  contexts.delete(token);
                  cancellation = endpoint
                    .streamControl(control("stream.cancel"), Buffer.alloc(0), metadata)
                    .then((result) => {
                      unwrap(decode(result));
                    });
                  void cancellation.catch(() => {});
                  return cancellation;
                };
                const abortStream = () => {
                  void cancel();
                };
                signal.addEventListener("abort", abortStream, { once: true });
                // Open is registered synchronously in the addon before cancellation can overtake it.
                const opening = endpoint.streamControl(control("stream.open"), Buffer.from(payload), metadata);
                if (signal.aborted) cancel();
                try {
                  unwrap(decode(await opening));
                } catch (error) {
                  cancel();
                  throw error;
                }
                if (signal.aborted) {
                  cancel();
                  throw unavailable();
                }
                const source: AsyncIterableIterator<Uint8Array> = {
                  [Symbol.asyncIterator]() {
                    return this;
                  },
                  async next() {
                    try {
                      const bytes = unwrap(
                        decode(await endpoint.streamControl(control("stream.next"), Buffer.alloc(0), metadata)),
                      );
                      const item = decodeFrame(bytes, seq++);
                      if (item.done) cancel();
                      return item;
                    } catch (error) {
                      cancel();
                      throw error;
                    }
                  },
                  async return() {
                    await cancel();
                    return { done: true as const, value: undefined };
                  },
                };
                return source;
              },
      })),
      events,
      async (route, payload, context) => {
        if (!ready || closed) return failure("OWNER_UNAVAILABLE", "Rust napi endpoint unavailable");
        return withContext(context, async (metadata) =>
          decode(await endpoint.dispatchLocal(JSON.stringify(route), Buffer.from(payload), metadata)),
        );
      },
    );
    endpoint.bind(
      async (metadata, payload) => {
        try {
          const control: Control = JSON.parse(metadata);
          if (control.version !== CONTROL_VERSION)
            return encode(failure("INCOMPATIBLE", "Rust napi control version mismatch"));
          if (control.operation === "closed") {
            cleanup();
            return Buffer.alloc(0);
          }
          if (!ready || closed) throw unavailable();
          if (control.operation === "event") {
            const sink = eventSinks.get(control.subscriptionId ?? "");
            if (!sink) throw unavailable();
            await sink(payload);
            return Buffer.alloc(0);
          }
          if (control.operation === "unsubscribe") {
            const id = control.subscriptionId ?? "";
            openingSubscriptions.delete(id);
            subscriptions.get(id)?.close();
            subscriptions.delete(id);
            return Buffer.alloc(0);
          }
          const cancelling = control.operation === "stream.cancel" ? streams.get(control.streamId ?? "") : undefined;
          const context =
            contexts.get(control.contextToken) ??
            (cancelling?.token === control.contextToken ? cancelling.context : undefined);
          if (!context) throw new GatewayFailure({ code: "UNAUTHORIZED", message: "unknown Rust napi caller token" });
          switch (control.operation) {
            case "invoke": {
              if (!control.route) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "missing route" });
              // A fallback to an advertised route of the same endpoint is stale, not another dispatch hop.
              if (manifest.routes.some((route) => route.name === control.route?.name)) {
                return encode(failure("UNKNOWN_ROUTE", "Rust napi local route missing"));
              }
              return encode(await host.invoke(context, control.route, payload));
            }
            case "stream.open": {
              const id = control.streamId;
              if (!id || streams.has(id) || !control.route) throw unavailable();
              if (manifest.routes.some((route) => route.name === control.route?.name))
                return encode(failure("UNKNOWN_ROUTE", "Rust napi local stream missing"));
              if (streams.size >= 128) return encode(failure("RESOURCE_EXHAUSTED", "endpoint streams full"));
              const session = {
                context,
                token: control.contextToken,
                controller: new AbortController(),
                seq: 0,
                stream: undefined as ResponseStream<Uint8Array> | undefined,
              };
              streams.set(id, session);
              try {
                const stream = await host.stream(context, control.route, payload, {
                  signal: session.controller.signal,
                });
                if (streams.get(id) !== session) {
                  await stream.cancel();
                  throw unavailable();
                }
                session.stream = stream;
                void stream.closed.then(() => {
                  if (streams.get(id) === session) streams.delete(id);
                });
                return Buffer.from(JSON.stringify(stream.policy));
              } catch (error) {
                if (streams.get(id) === session) streams.delete(id);
                throw error;
              }
            }
            case "stream.next":
            case "stream.cancel": {
              const id = control.streamId ?? "";
              const session = streams.get(id);
              if (!session) {
                if (control.operation === "stream.cancel") return Buffer.alloc(0);
                throw unavailable();
              }
              if (session.context !== context) return encode(failure("UNAUTHORIZED", "stream caller mismatch"));
              if (control.operation === "stream.cancel") {
                streams.delete(id);
                session.controller.abort();
                await session.stream?.cancel();
                return Buffer.alloc(0);
              }
              if (!session.stream) throw unavailable();
              try {
                const item = await session.stream.next();
                const frame = encodeFrame(session.seq++, item);
                if (item.done) streams.delete(id);
                return Buffer.from(frame);
              } catch (error) {
                if (!(error instanceof GatewayFailure && error.detail.code === "CONCURRENCY_FULL")) streams.delete(id);
                throw error;
              }
            }
            case "subscribe": {
              const id = control.subscriptionId;
              if (!id || !control.event || subscriptions.has(id) || openingSubscriptions.has(id)) {
                throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid Rust napi subscription" });
              }
              openingSubscriptions.add(id);
              const subscription = await host.subscribe(
                context,
                control.event,
                control.filterPresent ? payload : undefined,
                async (bytes) => {
                  unwrap(decode(await endpoint.deliver(id, Buffer.from(bytes))));
                },
                true,
              );
              const stillOpening = openingSubscriptions.delete(id);
              if (closed || !stillOpening) {
                subscription.close();
                throw unavailable();
              }
              subscriptions.set(id, subscription);
              // Source/host already applies event policy; preserve all accepted deliveries downstream.
              return Buffer.from(JSON.stringify("ordered"));
            }
            default:
              return encode(failure("WRONG_METHOD_KIND", "unsupported Rust napi control operation"));
          }
        } catch (error) {
          return encode(
            error instanceof GatewayFailure
              ? { ok: false, error: error.detail }
              : failure("HANDLER_ERROR", "Rust napi host callback failed"),
          );
        }
      },
      contextJson(originToken, origin),
    );
    unwrap(decode(await endpoint.activate()));
    ready = true;
    owner = reservation.publish();
    owner.onClose(() => {
      void close().catch(() => {});
    });
    return Object.freeze({ manifest: owner.manifest, instance: owner.instance, close });
  } catch (error) {
    reservation?.close();
    try {
      await close();
    } catch {
      /* Preserve the original handshake failure. */
    }
    throw error;
  }
}
