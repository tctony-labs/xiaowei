import { type Client, createClient } from "./client.js";
import { authorize, type CallContext, caller, createContext, type Permissions } from "./context.js";
import { type EventExport, Events } from "./event.js";
import { ExecutionScope } from "./execution.js";
import {
  accepts,
  type EventSink,
  failure,
  type GatewayError,
  GatewayFailure,
  invalid,
  type Manifest,
  type Result,
  type Route,
  type Subscription,
  type Transport,
  validateName,
  validateRoute,
} from "./protocol.js";
import { type ByteSource, type ResponseStream, type StreamOptions, type StreamPolicy, streamPolicy } from "./stream.js";

export { type CallContext, createContext, type Permissions } from "./context.js";
export type { EventExport } from "./event.js";
export interface Registration {
  route: Route;
  handler?: (payload: Uint8Array, client: Client, context: CallContext) => Promise<Uint8Array> | Uint8Array;
  streamHandler?: (
    payload: Uint8Array,
    client: Client,
    signal: AbortSignal,
    context: CallContext,
  ) => ByteSource | Promise<ByteSource>;
  streamPolicy?: Partial<StreamPolicy>;
  timeoutMs?: number;
  maxConcurrency?: number;
}
export type Dispatcher = (route: Route, payload: Uint8Array, context: CallContext) => Promise<Result<Uint8Array>>;
export type StreamDispatcher = (
  route: Route,
  payload: Uint8Array,
  context: CallContext,
  options: StreamOptions,
) => Promise<ResponseStream<Uint8Array>>;
interface Entry {
  registration: Registration;
  owner: Owner;
}
interface Owner {
  name: string;
  instance: number;
  closed: boolean;
  pending: Set<(result: Result<Uint8Array>) => void>;
  dispatcher?: Dispatcher;
  streamDispatcher?: StreamDispatcher;
  closedListeners: Set<() => void>;
}
export interface OwnerHandle {
  readonly instance: number;
  readonly manifest: Manifest;
  close(reason?: GatewayError): void;
  onClose(listener: () => void): void;
  publish(event: string, payload: Uint8Array): void;
  dispatchLocal(route: Route, payload: Uint8Array, context: CallContext): Promise<Result<Uint8Array>>;
}

/** One host per process. Only this host owns the global manifest and owner table. */
export class GatewayHost {
  private execution = new ExecutionScope();
  private streams = new Set<{ owner: Owner; caller: string; controller: AbortController }>();
  private entries = new Map<string, Entry>();
  private owners = new Map<string, Owner>();
  private events = new Events();
  private nextInstance = 0;
  private reservations = new Map<object, { name: string; routes: Set<string>; events: Set<string> }>();
  constructor(private remote?: Dispatcher) {}

  client(permissions: Permissions): Client {
    return createClient(this.transport(createContext(permissions)));
  }
  transport(context: CallContext): Transport {
    return Object.freeze({
      stream: (route: Route, payload: Uint8Array, options?: StreamOptions) =>
        this.stream(context, route, payload, options),
      invoke: (route: Route, payload: Uint8Array) => this.invoke(context, route, payload),
      subscribe: (event: string, filter: Uint8Array | undefined, sink: EventSink, persistent = false) =>
        this.subscribe(context, event, filter, sink, persistent),
    });
  }

  registerOwner(
    name: string,
    registrations: readonly Registration[],
    events: readonly EventExport[] = [],
    dispatcher?: Dispatcher,
    streamDispatcher?: StreamDispatcher,
  ): OwnerHandle {
    const snapshot = this.validateOwner(name, registrations, events, dispatcher);
    const old = this.owners.get(name);
    if (old) this.closeOwner(old);
    const owner: Owner = {
      name,
      instance: ++this.nextInstance,
      closed: false,
      pending: new Set(),
      dispatcher,
      streamDispatcher,
      closedListeners: new Set(),
    };
    this.owners.set(name, owner);
    for (const registration of snapshot) this.entries.set(registration.route.name, { registration, owner });
    this.events.install(owner, name, events);
    const manifest: Manifest = Object.freeze({
      routes: Object.freeze(
        snapshot.map((entry) =>
          Object.freeze({
            ...entry.route,
            timeoutMs: entry.timeoutMs ?? 30_000,
            maxConcurrency: entry.maxConcurrency ?? 32,
            streamPolicy: entry.streamPolicy,
          }),
        ),
      ),
      events: Object.freeze(events.map(({ name, policy }) => Object.freeze({ name, policy }))),
    });
    return Object.freeze({
      instance: owner.instance,
      manifest,
      close: (reason?: GatewayError) => this.closeOwner(owner, reason),
      onClose: (listener: () => void) => {
        if (owner.closed) listener();
        else owner.closedListeners.add(listener);
      },
      publish: (event: string, payload: Uint8Array) => {
        if (owner.closed) throw new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "owner instance closed" });
        this.events.publish(owner, event, payload);
      },
      dispatchLocal: (route: Route, payload: Uint8Array, context: CallContext) =>
        this.dispatchLocal(owner, context, route, payload),
    });
  }

  private validateOwner(
    name: string,
    registrations: readonly Registration[],
    events: readonly EventExport[],
    dispatcher?: Dispatcher,
  ): Registration[] {
    validateName(name);
    const names = new Set<string>();
    const snapshot = registrations.map((registration) => ({
      ...registration,
      route: Object.freeze({ ...registration.route }),
      streamPolicy: registration.streamPolicy ? Object.freeze(streamPolicy(registration.streamPolicy)) : undefined,
    }));
    for (const registration of snapshot) {
      const { route } = registration;
      if (registration.streamPolicy) streamPolicy(registration.streamPolicy);
      if (registration.streamHandler && route.kind !== "serverStreaming") invalid("invalid stream handler kind");
      validateRoute(route);
      const existing = this.entries.get(route.name);
      if (names.has(route.name) || (existing && existing.owner.name !== name)) {
        throw new GatewayFailure({ code: "CONFLICT", message: "route already registered" });
      }
      names.add(route.name);
      if (
        (!dispatcher && route.kind === "unary" && !registration.handler) ||
        (dispatcher && registration.handler) ||
        (route.kind === "serverStreaming" && registration.handler)
      ) {
        invalid("invalid handler kind");
      }
      for (const value of [registration.timeoutMs ?? 30_000, registration.maxConcurrency ?? 32]) {
        if (!Number.isSafeInteger(value) || value <= 0) invalid("invalid execution policy");
      }
      if ((registration.timeoutMs ?? 30_000) > 2_147_483_647) invalid("timeout exceeds timer range");
    }
    this.events.validateOwner(name, events);
    for (const reserved of this.reservations.values()) {
      if (
        reserved.name === name ||
        snapshot.some((r) => reserved.routes.has(r.route.name)) ||
        events.some((event) => reserved.events.has(event.name))
      ) {
        throw new GatewayFailure({ code: "CONFLICT", message: "owner manifest is reserved" });
      }
    }
    return snapshot;
  }

  /** Reserve names without publishing routes/events or replacing the running owner. */
  reserveOwner(
    name: string,
    registrations: readonly Registration[],
    events: readonly EventExport[],
    dispatcher: Dispatcher,
    streamDispatcher?: StreamDispatcher,
  ) {
    const snapshot = this.validateOwner(name, registrations, events, dispatcher);
    const eventSnapshot = events.map((event) => ({ ...event }));
    const token = {};
    this.reservations.set(token, {
      name,
      routes: new Set(snapshot.map((r) => r.route.name)),
      events: new Set(eventSnapshot.map((e) => e.name)),
    });
    return {
      publish: () => {
        if (!this.reservations.delete(token))
          throw new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "reservation closed" });
        return this.registerOwner(name, snapshot, eventSnapshot, dispatcher, streamDispatcher);
      },
      close: () => {
        this.reservations.delete(token);
      },
    };
  }

  private closeOwner(
    owner: Owner,
    reason: GatewayError = { code: "OWNER_UNAVAILABLE", message: "owner closed" },
  ): void {
    if (owner.closed) return;
    owner.closed = true;
    this.execution.close(owner, reason);
    for (const stream of this.streams) if (stream.owner === owner) stream.controller.abort(new GatewayFailure(reason));
    for (const finish of owner.pending) finish({ ok: false, error: reason });
    owner.pending.clear();
    for (const [route, entry] of this.entries) if (entry.owner === owner) this.entries.delete(route);
    if (this.owners.get(owner.name) === owner) this.owners.delete(owner.name);
    this.events.remove(owner);
    for (const listener of owner.closedListeners) {
      try {
        listener();
      } catch {
        /* Cleanup of one endpoint must not strand the others. */
      }
    }
    owner.closedListeners.clear();
  }

  /** Authorized route metadata for finite transport waits, not another execution limiter. */
  executionPolicy(context: CallContext, route: Route) {
    authorize(context, route.name);
    validateRoute(route);
    const entry = this.entries.get(route.name);
    if (!entry) throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "route not registered" });
    const actual = entry.registration.route;
    const compatible =
      actual.kind === "serverStreaming" && route.kind === "serverStreaming"
        ? accepts({ ...actual, kind: "unary" }, { ...route, kind: "unary" })
        : accepts(actual, route);
    if (!compatible.ok) throw new GatewayFailure(compatible.error);
    return Object.freeze({
      timeoutMs: entry.registration.timeoutMs ?? 30_000,
      streamPolicy: Object.freeze(streamPolicy(entry.registration.streamPolicy)),
    });
  }

  async invoke(context: CallContext, route: Route, payload: Uint8Array): Promise<Result<Uint8Array>> {
    try {
      authorize(context, route.name);
      validateRoute(route);
      if (route.kind !== "unary") return failure("WRONG_METHOD_KIND", "stream execution requires stream API");
      if (!(payload instanceof Uint8Array)) invalid("payload must be PB bytes");
      const entry = this.entries.get(route.name);
      if (entry) return this.execute(entry, context, route, payload);
      if (this.remote) return await this.remote(route, payload, context);
      return failure("UNKNOWN_ROUTE", "route not registered");
    } catch (error) {
      return this.errorResult(error);
    }
  }

  private async dispatchLocal(
    owner: Owner,
    context: CallContext,
    route: Route,
    payload: Uint8Array,
  ): Promise<Result<Uint8Array>> {
    try {
      authorize(context, route.name);
      if (owner.closed) return failure("OWNER_UNAVAILABLE", "owner instance closed");
      const entry = this.entries.get(route.name);
      if (!entry) return failure("UNKNOWN_ROUTE", "route not registered");
      if (entry.owner !== owner) return failure("OWNER_UNAVAILABLE", "owner instance replaced");
      if (!(payload instanceof Uint8Array)) invalid("payload must be PB bytes");
      return this.execute(entry, context, route, payload);
    } catch (error) {
      return this.errorResult(error);
    }
  }

  private execute(entry: Entry, context: CallContext, route: Route, payload: Uint8Array): Promise<Result<Uint8Array>> {
    const compatible = accepts(entry.registration.route, route);
    if (!compatible.ok) return Promise.resolve(compatible);
    const { owner, registration } = entry;
    if (owner.closed) return Promise.resolve(failure("OWNER_UNAVAILABLE", "owner instance closed"));
    const dispatcher = owner.dispatcher;
    if (!dispatcher) {
      return this.execution.invoke(registration, owner, context, createClient(this.transport(context)), payload);
    }
    return new Promise((resolve) => {
      const finish = (result: Result<Uint8Array>) => {
        owner.pending.delete(finish);
        resolve(result);
      };
      owner.pending.add(finish);
      const run = async () => dispatcher(route, payload, context);
      run().then(finish, (error) => finish(this.errorResult(error)));
    });
  }

  async stream(context: CallContext, route: Route, payload: Uint8Array, options: StreamOptions = {}) {
    authorize(context, route.name);
    validateRoute(route);
    if (route.kind !== "serverStreaming") invalid("stream API requires streaming route");
    if (!(payload instanceof Uint8Array)) invalid("payload must be PB bytes");
    const entry = this.entries.get(route.name);
    if (!entry) throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "stream route not registered" });
    const { registration, owner } = entry;
    const compatible = accepts({ ...registration.route, kind: "unary" }, { ...route, kind: "unary" });
    if (!compatible.ok) throw new GatewayFailure(compatible.error);
    if (!owner.streamDispatcher) {
      return this.execution.stream(
        registration,
        owner,
        context,
        createClient(this.transport(context)),
        payload,
        options,
      );
    }
    const controller = new AbortController();
    const state = { owner, caller: caller(context), controller };
    this.streams.add(state);
    const abort = () => controller.abort(options.signal?.reason);
    const release = () => {
      this.streams.delete(state);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const stream = await owner.streamDispatcher(route, payload, context, { signal: controller.signal });
      void stream.closed.then(release);
      return stream;
    } catch (error) {
      release();
      throw error;
    }
  }

  private errorResult(error: unknown): Result<never> {
    return error instanceof GatewayFailure
      ? { ok: false, error: { ...error.detail } }
      : failure("HANDLER_ERROR", "handler or transport failed");
  }
  subscribe(
    context: CallContext,
    event: string,
    filter: Uint8Array | undefined,
    sink: EventSink,
    persistent = false,
  ): Promise<Subscription> {
    return this.events.subscribe(context, event, filter, sink, persistent);
  }
  cleanupCaller(id: string): void {
    for (const stream of this.streams) if (stream.caller === id) stream.controller.abort();
    this.execution.cleanupCaller(id);
    this.events.cleanupCaller(id);
  }
}
