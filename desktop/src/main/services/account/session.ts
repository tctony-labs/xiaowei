import { randomUUID } from "node:crypto";
import { type DescMethod, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  Auth,
  type Authenticated,
  AuthenticatedSchema,
  ConnectionAuthentication as Authentication,
  type CloudConnectionStatus,
  ConnectionChangedSchema,
  type LoginRequest,
  LoginRequestSchema,
} from "proto-desktop-ts";
import { type Client, methodRoute } from "xiaowei-gateway";
import { contextPermissions, type GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi, type RustNapiEndpoint } from "xiaowei-gateway/rust-napi";
import { type AccountOperationContext, type AccountOperationResult, XwAccount } from "xiaowei-rust";
import { AccountError } from "./errors";
import type { SavedSession } from "./store";

export interface SessionInput {
  server: string;
  session?: SavedSession;
  connect?: boolean;
  force?: boolean;
  login?: LoginRequest;
}

type Command = "login" | "restore" | "logout" | "revoke";

export interface SessionExecutor {
  withServerContext<T>(
    client: Client,
    context: { server: string },
    work: (client: Client) => Promise<T>,
  ): Promise<T>;
  execute(
    command: Command,
    input: SessionInput,
    client: Client,
    signal: AbortSignal,
    accept: (authenticated: Authenticated) => Promise<void>,
  ): Promise<void>;
  nextMaintenanceAt(): number;
}

export async function registerAccountSession(
  host: GatewayHost,
  callbacks: {
    changed?(status: CloudConnectionStatus): void;
    unauthorized?(accessToken: string): void;
  } = {},
  now: () => number = Date.now,
) {
  const native = new XwAccount();
  const endpoint = native.createGatewayEndpoint();
  const scopes = new Map<string, object>();
  let nextAt = now() + 30_000;
  let unsubscribe: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let rejectedGeneration = -1n;
  let readContext: () => SessionInput = () => ({ server: "" });
  const metadata = (value: string) => {
    const context = JSON.parse(value) as { caller: string };
    return JSON.stringify({ ...context, accountSession: scopes.get(context.caller) });
  };
  const adapter: RustNapiEndpoint = {
    manifest: () => endpoint.manifest(),
    bind: (callback, context) => endpoint.bind(callback, context),
    activate: () => endpoint.activate(),
    rpcControl: (control, payload, context) =>
      endpoint.rpcControl(control, payload, metadata(context)),
    streamControl: (control, payload, context) => endpoint.streamControl(control, payload, context),
    dispatchLocal: (route, payload, context) => endpoint.dispatchLocal(route, payload, context),
    subscribeLocal: (id, event, filter, context) =>
      endpoint.subscribeLocal(id, event, filter, context),
    unsubscribeLocal: (id) => endpoint.unsubscribeLocal(id),
    deliver: (id, payload) => endpoint.deliver(id, payload),
    close: () => endpoint.close(),
  };
  const owner = await attachRustNapi(host, "server-api", adapter);
  const observer = host.client({ caller: "account-connection", trusted: true });
  const connection = await observer
    .subscribe(ConnectionChangedSchema.typeName, undefined, (bytes) => {
      if (closed) return;
      const change = fromBinary(ConnectionChangedSchema, bytes);
      const generation = BigInt(native.connectionGeneration());
      if (change.generation !== generation) return;
      const credential = readContext().session?.authenticated.tokens?.accessToken ?? "";
      callbacks.changed?.((change.status + 1) as CloudConnectionStatus);
      if (change.authentication === Authentication.REJECTED && rejectedGeneration !== generation) {
        rejectedGeneration = generation;
        callbacks.unauthorized?.(credential);
      }
    })
    .catch(async (error) => {
      await owner.close();
      throw error;
    });
  const serialize = (input: SessionInput) => ({
    server: input.server,
    sessionServer: input.session?.server,
    authenticated:
      input.session && Array.from(toBinary(AuthenticatedSchema, input.session.authenticated)),
    connect: input.connect ?? false,
    nowMs: now(),
  });
  const executor: SessionExecutor = {
    async withServerContext(client, context, work) {
      const caller = `account-target:${randomUUID()}`;
      const scoped = host.client({ ...contextPermissions(client.context()), caller });
      scopes.set(caller, serialize(context));
      try {
        return await work(scoped);
      } finally {
        scopes.delete(caller);
      }
    },
    nextMaintenanceAt: () => nextAt,
    async execute(command, input, client, signal, accept) {
      const permissions = contextPermissions(client.context());
      const allowed = (method: DescMethod) =>
        permissions.trusted || !!permissions.invoke?.includes(methodRoute(method).name);
      const access = {
        login: allowed(Auth.method.login),
        refresh: allowed(Auth.method.refresh),
        currentUser: allowed(Auth.method.getCurrentUser),
        logout: allowed(Auth.method.logout),
      };
      const context: AccountOperationContext = {
        operationId: randomUUID(),
        server: input.server,
        sessionServer: input.session?.server,
        authenticated: input.session
          ? Buffer.from(toBinary(AuthenticatedSchema, input.session.authenticated))
          : undefined,
        connect: input.connect ?? false,
        nowMs: now(),
      };
      let started = false;
      let acceptedAuthenticated: Buffer | undefined;
      const abort = () => native.cancelOperation(context.operationId);
      async function consume(result: AccountOperationResult) {
        if (result.authenticated && !acceptedAuthenticated?.equals(result.authenticated)) {
          // Retain before awaiting persistence: failed saving must not replay this checkpoint.
          acceptedAuthenticated = result.authenticated;
          await accept(fromBinary(AuthenticatedSchema, result.authenticated));
        }
        if (input.connect) nextAt = result.nextMaintenanceAtMs;
      }
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        let pending: Promise<AccountOperationResult>;
        if (command === "login") {
          if (!input.login) throw new Error("Missing login request");
          pending = native.login(
            context,
            Buffer.from(toBinary(LoginRequestSchema, input.login)),
            access,
          );
        } else if (command === "restore") {
          pending = native.restore(context, input.force ?? false, access);
        } else {
          pending = native[command](context, access);
        }
        started = true;
        if (signal.aborted) abort();
        let result = await pending;
        while (true) {
          await consume(result);
          if (result.code !== 0) throw new AccountError(result.code, result.msg);
          signal.throwIfAborted();
          if (!result.checkpoint) break;
          result = await native.continueOperation(context.operationId, context.nowMs);
        }
      } catch (error) {
        if (started) {
          // Stop this exact operation, then collect any credentials rotated before cancellation.
          try {
            native.cancelOperation(context.operationId);
            await consume(await native.readResult(context.operationId, context.nowMs));
          } catch {
            console.warn("Account retained credential delivery failed");
          }
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        native.releaseOperation(context.operationId);
      }
    },
  };
  return {
    ...executor,
    start(read: () => SessionInput, subscribe: (listener: () => void) => () => void) {
      readContext = read;
      const update = () => {
        nextAt = native.setSession(JSON.stringify(serialize(read())));
      };
      unsubscribe?.();
      unsubscribe = subscribe(update);
      update();
    },
    close() {
      if (!closing) {
        closed = true;
        unsubscribe?.();
        connection.close();
        scopes.clear();
        closing = owner.close();
      }
      return closing;
    },
  };
}
