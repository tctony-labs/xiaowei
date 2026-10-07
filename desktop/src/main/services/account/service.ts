import { create } from "@bufbuild/protobuf";
import {
  type AccountLoginRequest,
  AccountOperationResponseSchema,
  AccountSnapshotSchema,
  AccountStatus,
  Auth,
  EmptySchema,
  ErrorCode,
  type GetCurrentUserData,
  LoginRequestSchema,
  RefreshRequestSchema,
  XwApiOptionsSchema,
} from "xiaowei-contracts";
import { bindClient, type Client, type Rpc } from "xiaowei-gateway";
import { normalizeServerAddress } from "../../../shared/server-address";
import { AccountError, accountError } from "./errors";
import type { AccountDocument, AccountStore, SavedSession } from "./store";

const REFRESH_LEAD_MS = 5 * 60_000;

interface AccountOptions {
  store: AccountStore;
  client: Client;
  withServerContext: <T>(
    client: Client,
    context: ReturnType<AccountService["serverContext"]>,
    work: (client: Client) => Promise<T>,
  ) => Promise<T>;
  deviceName: string;
  now?: () => number;
}

export class AccountService {
  private session?: SavedSession;
  private status = AccountStatus.SIGNED_OUT;
  private message = "";
  private revision = 1n;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private network?: AbortController;
  private loginAttempt?: { id: string; controller: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private dirtySession = false;
  private closed = false;
  private closing?: Promise<void>;

  private constructor(
    private document: AccountDocument,
    private readonly store: AccountStore,
    private readonly client: Client,
    private readonly withServerContext: AccountOptions["withServerContext"],
    private readonly deviceName: string,
    private readonly now: () => number,
  ) {
    try {
      this.session = document.session;
      if (this.session) {
        const authenticated = this.session.authenticated;
        if (
          this.session.server !== document.selectedServer ||
          authenticated.device?.deviceId !== document.deviceId ||
          !authenticated.user?.userId ||
          !authenticated.tokens?.accessToken ||
          !authenticated.tokens.refreshToken ||
          !authenticated.tokens.sessionId ||
          authenticated.tokens.accessExpiresAtMs <= 0n ||
          authenticated.tokens.refreshExpiresAtMs <= 0n
        ) {
          this.session = undefined;
          throw new AccountError(ErrorCode.INTERNAL_ERROR, "无法读取已保存的登录凭据，请重新登录");
        }
      }
      if (this.session) this.status = AccountStatus.RESTORING;
    } catch (error) {
      this.message = accountError(error).message;
      console.warn("Saved account credentials unavailable");
    }
  }

  static async open(options: AccountOptions) {
    const document = await options.store.load();
    return new AccountService(
      document,
      options.store,
      options.client,
      options.withServerContext,
      options.deviceName,
      options.now ?? Date.now,
    );
  }

  // Read on each request; never cache credentials in the Gateway owner.
  serverContext(session = this.session) {
    const tokens = session?.authenticated.tokens;
    return {
      server: session?.server ?? this.document.selectedServer,
      session:
        session && tokens
          ? {
              server: session.server,
              sessionId: tokens.sessionId,
              accessToken: tokens.accessToken,
              accessExpiresAtMs: tokens.accessExpiresAtMs,
            }
          : undefined,
    };
  }

  snapshot() {
    return create(AccountSnapshotSchema, {
      revision: this.revision,
      servers: [...this.document.servers],
      selectedServer: this.document.selectedServer,
      status: this.status,
      user: this.session?.authenticated.user,
      statusMessage: this.message,
    });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    if (this.closed) return;
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(() => {
      if (this.closed) throw new AccountError(ErrorCode.UNAVAILABLE, "账号服务已关闭");
      return work();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async operation(work: () => Promise<void>) {
    try {
      await this.enqueue(work);
      return create(AccountOperationResponseSchema, { snapshot: this.snapshot() });
    } catch (error) {
      const failure = accountError(error);
      return create(AccountOperationResponseSchema, {
        code: failure.code,
        msg: failure.message,
        snapshot: this.snapshot(),
      });
    }
  }

  private async request<T extends { code: number; msg: string }>(rpc: Rpc<T>, signal: AbortSignal): Promise<T> {
    const abort = () => rpc.cancel();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await rpc;
      if (response.code !== 0) throw new AccountError(response.code, response.msg);
      return response;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private signedOutOnly() {
    if (this.session) throw new AccountError(ErrorCode.INVALID_ARGUMENT, "请先退出登录，再选择服务器");
  }

  private async save(document: AccountDocument) {
    await this.store.save(document);
    this.document = document;
  }

  private async persistSession() {
    await this.save({ ...this.document, session: this.session });
    this.dirtySession = false;
  }

  private abortNetwork() {
    this.network?.abort();
    this.loginAttempt?.controller.abort();
    clearTimeout(this.timer);
  }

  addServer(address: string) {
    if (!this.session) this.abortNetwork();
    return this.operation(async () => {
      this.signedOutOnly();
      let normalized: string;
      try {
        normalized = normalizeServerAddress(address);
      } catch (error) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, (error as Error).message);
      }
      if (this.document.servers.includes(normalized)) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "该服务器地址已保存，请从列表中选择");
      }
      await this.save({
        ...this.document,
        servers: [...this.document.servers, normalized],
        selectedServer: normalized,
        session: undefined,
      });
      this.message = "";
      this.changed();
    });
  }

  selectServer(address: string) {
    if (!this.session) this.abortNetwork();
    return this.operation(async () => {
      this.signedOutOnly();
      if (!this.document.servers.includes(address)) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "请从已保存的服务器中选择");
      }
      await this.save({ ...this.document, selectedServer: address, session: undefined });
      this.message = "";
      this.changed();
    });
  }

  login(request: AccountLoginRequest, client = this.client) {
    if (this.loginAttempt) {
      return Promise.resolve(
        create(AccountOperationResponseSchema, {
          code: ErrorCode.INVALID_ARGUMENT,
          msg: "登录正在进行",
          snapshot: this.snapshot(),
        }),
      );
    }
    const attempt = { id: request.attemptId, controller: new AbortController() };
    this.loginAttempt = attempt;
    const signal = client.cancellation();
    const abort = () => attempt.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const api = bindClient(Auth, client, { optionsSchema: XwApiOptionsSchema });
    return this.operation(async () => {
      this.signedOutOnly();
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attempt.id) ||
        request.serverAddress !== this.document.selectedServer ||
        !request.serverAddress ||
        !request.password?.email ||
        !request.password.password
      ) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "登录参数无效，请重新打开登录窗口");
      }
      this.network = attempt.controller;
      this.status = AccountStatus.SIGNING_IN;
      this.message = "";
      this.changed();
      let received: SavedSession | undefined;
      let accepted = false;
      try {
        attempt.controller.signal.throwIfAborted();
        const response = await this.request(
          api.login(
            create(LoginRequestSchema, {
              deviceId: this.document.deviceId,
              deviceName: this.deviceName,
              credential: { case: "password", value: request.password },
            }),
          ),
          attempt.controller.signal,
        );
        const result = response.data?.result;
        if (result?.case !== "authenticated") {
          throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无法建立会话的登录结果");
        }
        received = { server: request.serverAddress, authenticated: result.value };
        attempt.controller.signal.throwIfAborted();
        await this.store.save({ ...this.document, session: received });
        if (attempt.controller.signal.aborted) {
          await this.store.save({ ...this.document, session: undefined });
          throw new AccountError(ErrorCode.UNAVAILABLE, "登录操作已取消");
        }
        this.document = { ...this.document, session: received };
        this.session = received;
        this.dirtySession = false;
        this.status = AccountStatus.SIGNED_IN;
        accepted = true;
        this.changed();
        this.schedule();
        console.info("Account signed in", { userId: received.authenticated.user?.userId });
      } finally {
        if (!accepted) {
          this.status = AccountStatus.SIGNED_OUT;
          this.changed();
          if (received) await this.revokeUncommitted(received, client);
        }
        if (this.network === attempt.controller) this.network = undefined;
      }
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      if (this.loginAttempt === attempt) this.loginAttempt = undefined;
    });
  }

  cancelLogin(attemptId: string) {
    if (this.loginAttempt?.id === attemptId) this.loginAttempt.controller.abort();
  }

  private async revokeUncommitted(session: SavedSession, client: Client) {
    try {
      await this.withServerContext(client, this.serverContext(session), async (scoped) => {
        const api = bindClient(Auth, scoped, { optionsSchema: XwApiOptionsSchema });
        await this.request(api.logout(create(EmptySchema)), new AbortController().signal);
      });
    } catch {
      console.warn("Uncommitted account session could not be revoked");
    }
  }

  private async clearSession(message = "") {
    await this.save({ ...this.document, session: undefined });
    this.session = undefined;
    this.dirtySession = false;
    this.status = AccountStatus.SIGNED_OUT;
    this.message = message;
    clearTimeout(this.timer);
    this.changed();
  }

  private async freshAccess(signal: AbortSignal, force = false, client = this.client): Promise<void> {
    const session = this.session;
    const tokens = session?.authenticated.tokens;
    if (!session || !tokens || Number(tokens.refreshExpiresAtMs) <= this.now()) {
      throw new AccountError(ErrorCode.UNAUTHENTICATED, "登录已失效，请重新登录");
    }
    if (this.dirtySession) await this.persistSession();
    if (force || Number(tokens.accessExpiresAtMs) <= this.now() + REFRESH_LEAD_MS) {
      const api = bindClient(Auth, client, { optionsSchema: XwApiOptionsSchema });
      const response = await this.request(
        api.refresh(create(RefreshRequestSchema, { refreshToken: tokens.refreshToken })),
        signal,
      );
      const next = response.data;
      if (!next) throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无效的刷新结果");
      if (next.sessionId !== tokens.sessionId) {
        throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了不匹配的会话");
      }
      // Rotation has consumed the old refresh token. Retain the new pair even if disk persistence fails.
      session.authenticated.tokens = next;
      this.dirtySession = true;
      await this.persistSession();
      console.info("Account session refreshed");
    }
  }

  private async restoreInside() {
    if (!this.session) return;
    const controller = new AbortController();
    this.network = controller;
    const api = bindClient(Auth, this.client, { optionsSchema: XwApiOptionsSchema });
    try {
      await this.freshAccess(controller.signal);
      let current: GetCurrentUserData | undefined;
      try {
        current = (await this.request(api.getCurrentUser(create(EmptySchema)), controller.signal)).data;
      } catch (error) {
        if (accountError(error).code !== ErrorCode.UNAUTHENTICATED) throw error;
        await this.freshAccess(controller.signal, true);
        current = (await this.request(api.getCurrentUser(create(EmptySchema)), controller.signal)).data;
      }
      controller.signal.throwIfAborted();
      if (
        !current ||
        current.user?.userId !== this.session.authenticated.user?.userId ||
        current.device?.deviceId !== this.document.deviceId ||
        current.sessionId !== this.session.authenticated.tokens?.sessionId
      ) {
        throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了不匹配的账号信息");
      }
      this.session.authenticated.user = current.user;
      await this.persistSession();
      this.status = AccountStatus.SIGNED_IN;
      this.message = "";
      this.changed();
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = accountError(error);
      if (failure.code === ErrorCode.UNAUTHENTICATED) {
        await this.clearSession("登录已失效，请重新登录");
        console.info("Account session expired or revoked");
      } else {
        this.status = AccountStatus.OFFLINE;
        this.message = failure.message;
        this.changed();
        console.warn("Account session validation unavailable", { code: failure.code });
      }
    } finally {
      if (this.network === controller) this.network = undefined;
      this.schedule();
    }
  }

  restore(): Promise<void> {
    this.refreshing ??= this.enqueue(() => this.restoreInside()).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.session) return;
    const expiry = Number(this.session.authenticated.tokens?.accessExpiresAtMs ?? 0n);
    const delay =
      this.status === AccountStatus.OFFLINE || this.dirtySession
        ? 30_000
        : Math.max(1_000, Math.min(2_147_483_647, expiry - this.now() - REFRESH_LEAD_MS));
    this.timer = setTimeout(() => {
      void this.restore().catch(() => console.warn("Account background restore failed"));
    }, delay);
    this.timer.unref();
  }

  logout(client = this.client) {
    this.abortNetwork();
    return this.operation(async () => {
      if (!this.session) return;
      const controller = new AbortController();
      this.network = controller;
      const signal = AbortSignal.any([controller.signal, client.cancellation()]);
      const api = bindClient(Auth, client, { optionsSchema: XwApiOptionsSchema });
      try {
        await this.freshAccess(signal, false, client);
        try {
          await this.request(api.logout(create(EmptySchema)), signal);
        } catch (error) {
          if (accountError(error).code !== ErrorCode.UNAUTHENTICATED) throw error;
          await this.freshAccess(signal, true, client);
          await this.request(api.logout(create(EmptySchema)), signal);
        }
      } catch (error) {
        if (accountError(error).code !== ErrorCode.UNAUTHENTICATED) {
          this.schedule();
          throw error;
        }
      } finally {
        if (this.network === controller) this.network = undefined;
      }
      await this.clearSession();
      console.info("Account signed out");
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.abortNetwork();
      await this.queue;
      if (this.dirtySession) await this.persistSession();
      this.listeners.clear();
    })();
    return this.closing;
  }
}
