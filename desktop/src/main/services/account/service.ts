import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  type AccountLoginRequest,
  type AccountLogoutRequest,
  AccountOperationResponseSchema,
  AccountSnapshotSchema,
  AccountStatus,
  AccountUserSchema,
  CloudConnectionStatus,
  ErrorCode,
  Health,
  LoginRequestSchema,
  type UserSnapshot,
} from "proto-desktop-ts";
import { bindClient, type Client, type Rpc } from "xiaowei-gateway";
import { normalizeServerAddress } from "../../../shared/server-address";
import { AccountError, accountError } from "./errors";
import type { SessionExecutor } from "./session";
import type { AccountDocument, AccountStore, SavedSession } from "./store";

interface AccountOptions {
  store: AccountStore;
  client: Client;
  deviceName: string;
  now?: () => number;
  sessions: SessionExecutor;
}

function accountUser(user: UserSnapshot | undefined) {
  return (
    user &&
    create(AccountUserSchema, {
      userId: user.userId,
      email: user.email,
      createdAtMs: user.createdAtMs,
    })
  );
}

export class AccountService {
  private session?: SavedSession;
  private status = AccountStatus.SIGNED_OUT;
  private message = "";
  private revision = 1n;
  private cloudConnection = CloudConnectionStatus.DISCONNECTED;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private network?: AbortController;
  private loginAttempt?: { id: string; controller: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private readonly dirtySessions = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;

  private constructor(
    private document: AccountDocument,
    private readonly store: AccountStore,
    private readonly client: Client,
    private readonly deviceName: string,
    private readonly now: () => number,
    private readonly sessions: SessionExecutor,
  ) {
    this.session = this.savedSession(document.selectedServer);
    if (this.session) this.status = AccountStatus.RESTORING;
    else if (document.sessions.some((entry) => entry.server === document.selectedServer)) {
      this.message = "无法读取已保存的登录凭据，请重新登录";
      console.warn("Saved account credentials unavailable");
    }
  }

  static async open(options: AccountOptions) {
    const document = await options.store.load();
    return new AccountService(
      document,
      options.store,
      options.client,
      options.deviceName,
      options.now ?? Date.now,
      options.sessions,
    );
  }

  private savedSession(server: string) {
    const session = this.document.sessions.find((entry) => entry.server === server);
    if (!session) return undefined;
    const authenticated = session.authenticated;
    if (
      authenticated.device?.deviceId !== this.document.deviceId ||
      !authenticated.user?.userId ||
      !authenticated.tokens?.accessToken ||
      !authenticated.tokens.refreshToken ||
      !authenticated.tokens.sessionId ||
      authenticated.tokens.accessExpiresAtMs <= 0n ||
      authenticated.tokens.refreshExpiresAtMs <= 0n
    ) {
      return undefined;
    }
    return session;
  }

  private withSession(session: SavedSession | undefined): AccountDocument {
    const server = session?.server ?? this.document.selectedServer;
    return {
      ...this.document,
      sessions: [
        ...this.document.sessions.filter((entry) => entry.server !== server),
        ...(session ? [session] : []),
      ],
    };
  }

  sessionContext() {
    return {
      server: this.session?.server ?? this.document.selectedServer,
      session: this.session,
      connect: true,
    };
  }

  snapshot() {
    return create(AccountSnapshotSchema, {
      revision: this.revision,
      servers: [...this.document.servers],
      selectedServer: this.document.selectedServer,
      status: this.status,
      user: accountUser(this.session?.authenticated.user),
      statusMessage: this.message,
      cloudConnection: this.cloudConnection,
      serverAccounts: this.document.servers.map((serverAddress) => ({
        serverAddress,
        user: accountUser(this.savedSession(serverAddress)?.authenticated.user),
      })),
    });
  }

  setCloudConnection(status: CloudConnectionStatus) {
    if (this.cloudConnection === status || this.closed) return;
    this.cloudConnection = status;
    this.changed();
    if (status === CloudConnectionStatus.CONNECTED && this.status !== AccountStatus.RESTORING) {
      void this.restore().catch(() => console.warn("Account connection recovery failed"));
    }
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

  private async request<T extends { code: number; msg: string }>(
    rpc: Rpc<T>,
    signal: AbortSignal,
  ): Promise<T> {
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

  private async save(document: AccountDocument) {
    await this.store.save(document);
    this.document = document;
    this.dirtySessions.clear();
  }

  private async persistSession() {
    await this.save(this.withSession(this.session));
  }

  private abortNetwork() {
    this.network?.abort();
    this.loginAttempt?.controller.abort();
    clearTimeout(this.timer);
  }

  private async activateServer(address: string, servers: string[], client = this.client) {
    if (this.dirtySessions.size) await this.persistSession();
    await this.save({ ...this.document, servers, selectedServer: address });
    this.session = undefined;
    this.status = AccountStatus.SIGNED_OUT;
    this.message = "";
    this.cloudConnection = CloudConnectionStatus.DISCONNECTED;
    this.session = this.savedSession(address);
    if (this.session) this.status = AccountStatus.RESTORING;
    else if (this.document.sessions.some((entry) => entry.server === address)) {
      this.message = "无法读取已保存的登录凭据，请重新登录";
      console.warn("Selected server credentials unavailable");
    }
    this.changed();
    console.info("Account server selected", { server: address, savedSession: !!this.session });
    if (this.session) await this.restoreInside(client);
  }

  addServer(address: string, client = this.client) {
    return this.operation(async () => {
      let normalized: string;
      try {
        normalized = normalizeServerAddress(address);
      } catch (error) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, (error as Error).message);
      }
      if (this.document.servers.includes(normalized)) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "该服务器地址已保存，请从列表中选择");
      }
      const controller = new AbortController();
      this.network = controller;
      const signal = AbortSignal.any([controller.signal, client.cancellation()]);
      try {
        signal.throwIfAborted();
        await this.sessions.withServerContext(client, { server: normalized }, async (scoped) => {
          const api = bindClient(Health, scoped);
          await this.request(api.check(create(EmptySchema)), signal);
        });
        signal.throwIfAborted();
        if (this.dirtySessions.size) await this.persistSession();
        await this.save({ ...this.document, servers: [...this.document.servers, normalized] });
        this.changed();
        console.info("Account server added after health check");
      } finally {
        if (this.network === controller) this.network = undefined;
      }
    }).finally(() => this.schedule());
  }

  selectServer(address: string, client = this.client) {
    if (address !== this.document.selectedServer) this.abortNetwork();
    return this.operation(async () => {
      if (!this.document.servers.includes(address)) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "请从已保存的服务器中选择");
      }
      if (address === this.document.selectedServer) return;
      await this.activateServer(address, this.document.servers, client);
    }).finally(() => this.schedule());
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
    return this.operation(async () => {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attempt.id) ||
        !this.document.servers.includes(request.serverAddress) ||
        !request.password?.email ||
        !request.password.password
      ) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "登录参数无效，请重新打开登录窗口");
      }
      if (this.savedSession(request.serverAddress)) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "该服务器已登录，请直接切换");
      }
      const password = request.password;
      if (this.dirtySessions.size) await this.persistSession();
      this.network = attempt.controller;
      const previousStatus = this.status;
      const previousMessage = this.message;
      const changesCurrent = request.serverAddress === this.document.selectedServer;
      if (changesCurrent) {
        this.status = AccountStatus.SIGNING_IN;
        this.message = "";
        this.changed();
      }
      let received: SavedSession | undefined;
      let accepted = false;
      try {
        attempt.controller.signal.throwIfAborted();
        await this.sessions.execute(
          "login",
          {
            server: request.serverAddress,
            login: create(LoginRequestSchema, {
              deviceId: this.document.deviceId,
              deviceName: this.deviceName,
              credential: {
                case: "password",
                value: { email: password.email, password: password.password },
              },
            }),
          },
          client,
          attempt.controller.signal,
          async (authenticated) => {
            received = { server: request.serverAddress, authenticated };
          },
        );
        if (!received) {
          throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无法建立会话的登录结果");
        }
        attempt.controller.signal.throwIfAborted();
        const next = { ...this.withSession(received), selectedServer: request.serverAddress };
        try {
          await this.store.save(next);
        } catch (error) {
          try {
            await this.store.save(this.document);
          } catch {
            console.warn("Uncommitted account selection could not be rolled back");
          }
          throw error;
        }
        if (attempt.controller.signal.aborted) {
          await this.store.save(this.document);
          throw new AccountError(ErrorCode.UNAVAILABLE, "登录操作已取消");
        }
        this.document = next;
        this.session = received;
        this.status = AccountStatus.SIGNED_IN;
        this.message = "";
        this.cloudConnection = CloudConnectionStatus.DISCONNECTED;
        accepted = true;
        this.changed();
        this.schedule();
        console.info("Account signed in", { userId: received.authenticated.user?.userId });
      } finally {
        if (!accepted) {
          if (changesCurrent) {
            this.status = previousStatus;
            this.message = previousMessage;
            this.changed();
          }
          if (received) await this.revokeUncommitted(received, client);
        }
        if (this.network === attempt.controller) this.network = undefined;
      }
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      if (this.loginAttempt === attempt) this.loginAttempt = undefined;
      this.schedule();
    });
  }

  cancelLogin(attemptId: string) {
    if (this.loginAttempt?.id === attemptId) this.loginAttempt.controller.abort();
  }

  private async revokeUncommitted(session: SavedSession, client: Client) {
    try {
      await this.sessions.execute(
        "revoke",
        { server: session.server, session },
        client,
        new AbortController().signal,
        async () => {},
      );
    } catch {
      console.warn("Uncommitted account session could not be revoked");
    }
  }

  private async clearSession(message = "", server = this.document.selectedServer) {
    await this.save({
      ...this.document,
      sessions: this.document.sessions.filter((entry) => entry.server !== server),
    });
    if (server === this.document.selectedServer) {
      this.session = undefined;
      this.status = AccountStatus.SIGNED_OUT;
      this.cloudConnection = CloudConnectionStatus.DISCONNECTED;
      this.message = message;
      clearTimeout(this.timer);
    }
    this.changed();
  }

  private async executeSession(
    command: "restore" | "logout",
    session: SavedSession,
    signal: AbortSignal,
    client: Client,
    force = false,
  ) {
    if (this.dirtySessions.size) await this.persistSession();
    await this.sessions.execute(
      command,
      {
        server: session.server,
        session,
        force,
        connect: session === this.session,
      },
      client,
      signal,
      async (authenticated) => {
        const previous = session.authenticated.tokens;
        const next = authenticated.tokens;
        const rotated =
          previous?.refreshToken !== next?.refreshToken ||
          previous?.accessToken !== next?.accessToken;
        // The shared core retains the pair before returning this checkpoint. Desktop keeps its
        // original in-memory-before-disk order and retries dirty persistence before more work.
        session.authenticated = authenticated;
        if (rotated) {
          this.dirtySessions.add(session.server);
          await this.persistSession();
          console.info("Account session refreshed");
        }
      },
    );
  }

  private async restoreInside(client = this.client, rejectedAccessToken?: string) {
    if (!this.session) return;
    if (
      rejectedAccessToken &&
      rejectedAccessToken !== this.session.authenticated.tokens?.accessToken
    )
      return;
    const controller = new AbortController();
    this.network = controller;
    const signal = AbortSignal.any([controller.signal, client.cancellation()]);
    const forceRefresh = !!rejectedAccessToken;
    try {
      await this.executeSession("restore", this.session, signal, client, forceRefresh);
      signal.throwIfAborted();
      await this.persistSession();
      this.status = AccountStatus.SIGNED_IN;
      this.message = "";
      this.changed();
    } catch (error) {
      if (signal.aborted) {
        if (this.status === AccountStatus.RESTORING) {
          this.status = AccountStatus.OFFLINE;
          this.message = "账号校验已取消，稍后重试";
          this.changed();
        }
        return;
      }
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

  restore(rejectedAccessToken?: string): Promise<void> {
    this.refreshing ??= this.enqueue(() =>
      this.restoreInside(this.client, rejectedAccessToken),
    ).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.session) return;
    const delay =
      this.status === AccountStatus.OFFLINE || this.dirtySessions.size > 0
        ? 30_000
        : Math.max(1_000, Math.min(2_147_483_647, this.sessions.nextMaintenanceAt() - this.now()));
    this.timer = setTimeout(() => {
      void this.restore().catch(() => console.warn("Account background restore failed"));
    }, delay);
    this.timer.unref();
  }

  logout(request?: AccountLogoutRequest, client = this.client) {
    this.abortNetwork();
    return this.operation(async () => {
      if (request?.allServers && request.serverAddress) {
        throw new AccountError(
          ErrorCode.INVALID_ARGUMENT,
          "退出目标不能同时指定服务器和全部服务器",
        );
      }
      const servers = request?.allServers
        ? this.document.sessions.map((entry) => entry.server)
        : [request?.serverAddress || this.document.selectedServer];
      if (servers.some((server) => !this.document.servers.includes(server))) {
        throw new AccountError(ErrorCode.INVALID_ARGUMENT, "请从已保存的服务器中选择");
      }
      const controller = new AbortController();
      this.network = controller;
      const signal = AbortSignal.any([controller.signal, client.cancellation()]);
      let failure: AccountError | undefined;
      let failures = 0;
      try {
        for (const server of servers) {
          signal.throwIfAborted();
          try {
            const session = this.savedSession(server);
            if (!session && !this.document.sessions.some((entry) => entry.server === server))
              continue;
            if (session) await this.revokeSavedSession(session, signal, client);
            signal.throwIfAborted();
            await this.clearSession("", server);
            console.info("Account saved session signed out");
          } catch (error) {
            if (signal.aborted) throw error;
            failure ??= accountError(error);
            failures++;
            console.warn("Account saved session logout unavailable", {
              code: accountError(error).code,
            });
          }
        }
        if (failure) {
          throw new AccountError(failure.code, `${failures} 个服务器退出失败：${failure.message}`);
        }
      } finally {
        if (this.network === controller) this.network = undefined;
        this.schedule();
      }
    });
  }

  private async revokeSavedSession(session: SavedSession, signal: AbortSignal, client: Client) {
    await this.executeSession("logout", session, signal, client);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.abortNetwork();
      await this.queue;
      if (this.dirtySessions.size) await this.persistSession();
      this.listeners.clear();
    })();
    return this.closing;
  }
}
