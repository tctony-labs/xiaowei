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

/** Structurally implemented by each addon's generated GatewayEndpoint class. */
export interface NativeEndpoint {
  manifest(): string;
  bind(callback: (control: string, payload: Buffer) => Promise<Buffer | string>, context: string): void;
  activate(): Promise<Buffer | string>;
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
  filterPresent: boolean;
}
function decode(reply: Buffer | string): Result<Uint8Array> {
  if (reply instanceof Uint8Array) return success(reply);
  const error: unknown = JSON.parse(reply);
  if (!error || typeof error !== "object" || !("code" in error) || !("message" in error)) {
    return failure("HANDLER_ERROR", "invalid native response");
  }
  return { ok: false, error: error as GatewayFailure["detail"] };
}
function encode(result: Result<Uint8Array>): Buffer | string {
  return result.ok ? Buffer.from(result.value) : JSON.stringify(result.error);
}
const unavailable = () => new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "native endpoint unavailable" });

/** No business addon imports. The application supplies a freshly created endpoint. */
export async function attachNative(
  host: GatewayHost,
  name: string,
  endpoint: NativeEndpoint,
  permissions: Permissions = { caller: name, trusted: true },
) {
  let manifest: Manifest & { controlVersion: number };
  try {
    manifest = JSON.parse(endpoint.manifest());
    if (manifest.controlVersion !== CONTROL_VERSION)
      throw new GatewayFailure({ code: "INCOMPATIBLE", message: "native control version mismatch" });
  } catch (error) {
    await endpoint.close();
    throw error;
  }
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
      manifest.routes.map((route) => ({ route, timeoutMs: route.timeoutMs, maxConcurrency: route.maxConcurrency })),
      events,
      async (route, payload, context) => {
        if (!ready || closed) return failure("OWNER_UNAVAILABLE", "native endpoint unavailable");
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
            return encode(failure("INCOMPATIBLE", "native control version mismatch"));
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
          const context = contexts.get(control.contextToken);
          if (!context) throw new GatewayFailure({ code: "UNAUTHORIZED", message: "unknown native caller token" });
          switch (control.operation) {
            case "invoke": {
              if (!control.route) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "missing route" });
              // A fallback to an advertised route of the same endpoint is stale, not another dispatch hop.
              if (manifest.routes.some((route) => route.name === control.route?.name)) {
                return encode(failure("UNKNOWN_ROUTE", "native local route missing"));
              }
              return encode(await host.invoke(context, control.route, payload));
            }
            case "subscribe": {
              const id = control.subscriptionId;
              if (!id || !control.event || subscriptions.has(id) || openingSubscriptions.has(id)) {
                throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid native subscription" });
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
              return encode(failure("WRONG_METHOD_KIND", "unsupported native control operation"));
          }
        } catch (error) {
          return encode(
            error instanceof GatewayFailure
              ? { ok: false, error: error.detail }
              : failure("HANDLER_ERROR", "native host callback failed"),
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
