import { Auth, CloudConnectionStatus } from "xiaowei-contracts";
import { type Client, GatewayFailure, methodRoute, type Route } from "xiaowei-gateway";
import { contextPermissions, type GatewayHost } from "xiaowei-gateway/host";
import { connectWebSocket, type WebSocketPeer } from "xiaowei-gateway/websocket";
import type { XwapiContext } from "./service";

export type ConnectionAuthentication = "authenticated" | "rejected" | "unavailable";

/** Owns one authenticated connection for the currently committed account session. */
export class ServerConnection {
  private peer?: WebSocketPeer;
  private pending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private key = "";
  private generation = 0;
  private failures = 0;
  private closed = false;
  private unsubscribe?: () => void;
  private authentication?: Promise<ConnectionAuthentication>;

  constructor(
    private host: GatewayHost,
    private readContext: () => Omit<XwapiContext, "signal">,
    private changed: (status: CloudConnectionStatus) => void,
    private unauthorized: (accessToken: string) => void = () => {},
  ) {}

  start(subscribe: (listener: () => void) => () => void) {
    this.unsubscribe = subscribe(() => this.update());
    this.update();
  }

  private sessionKey(context: Omit<XwapiContext, "signal">) {
    const session = context.session;
    if (
      !session?.accessToken ||
      !session.sessionId ||
      session.server !== context.server ||
      session.accessExpiresAtMs <= BigInt(Date.now())
    )
      return "";
    return JSON.stringify([session.server, session.sessionId, session.accessToken]);
  }

  private update() {
    if (this.closed) return;
    const key = this.sessionKey(this.readContext());
    if (key === this.key) return;
    this.key = key;
    this.generation++;
    this.stopConnection();
    this.failures = 0;
    if (key) this.authentication = this.connect(this.generation);
    else this.changed(CloudConnectionStatus.DISCONNECTED);
  }

  // Require the same capability as GetCurrentUser; an existing peer grants no permissions.
  async authenticate(client: Client, signal: AbortSignal): Promise<ConnectionAuthentication> {
    const permissions = contextPermissions(client.context());
    if (
      !permissions.trusted &&
      !permissions.invoke?.includes(methodRoute(Auth.method.getCurrentUser).name)
    ) {
      throw new GatewayFailure({ code: "UNAUTHORIZED", message: "capability not authorized" });
    }
    signal.throwIfAborted();
    this.update();
    if (this.closed || !this.key) return "unavailable";
    const key = this.key;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new DOMException("Connection validation cancelled", "AbortError"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      const result = await Promise.race([this.authentication, cancelled]);
      signal.throwIfAborted();
      if (result === "authenticated" && !this.peer) return "unavailable";
      return !this.closed && key === this.key ? (result ?? "unavailable") : "unavailable";
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private failed(generation: number, token: string, reason?: unknown) {
    const rejected = reason instanceof GatewayFailure && reason.detail.code === "UNAUTHORIZED";
    this.authentication = Promise.resolve(rejected ? "rejected" : "unavailable");
    if (rejected) {
      this.changed(CloudConnectionStatus.DISCONNECTED);
      console.warn("Server WebSocket authentication rejected; waiting for refreshed credentials");
      this.unauthorized(token);
    } else {
      this.retry(generation);
    }
    return rejected ? "rejected" : "unavailable";
  }

  private async connect(generation: number): Promise<ConnectionAuthentication> {
    if (this.closed || generation !== this.generation) return "unavailable";
    const context = this.readContext();
    if (this.sessionKey(context) !== this.key || !context.session) {
      this.update();
      return "unavailable";
    }
    const controller = new AbortController();
    this.pending = controller;
    this.changed(
      this.failures ? CloudConnectionStatus.RECONNECTING : CloudConnectionStatus.CONNECTING,
    );
    let lost = false;
    const disconnected = (reason?: GatewayFailure) => {
      lost = true;
      if (this.closed || generation !== this.generation || controller.signal.aborted) return;
      this.peer = undefined;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.failed(generation, context.session?.accessToken ?? "", reason);
    };
    try {
      const address = new URL(`${context.server}/api/ws`);
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      const peer = await connectWebSocket({
        url: address.href,
        token: context.session.accessToken,
        exports: { host: this.host, manifest: { routes: [], events: [] } },
        signal: controller.signal,
        onClose: disconnected,
      });
      if (lost || this.closed || generation !== this.generation || controller.signal.aborted) {
        peer.close();
        return "unavailable";
      }
      this.pending = undefined;
      this.peer = peer;
      this.failures = 0;
      this.changed(CloudConnectionStatus.CONNECTED);
      console.info("Server WebSocket connected");
      let pinging = false;
      this.heartbeat = setInterval(() => {
        if (pinging) return;
        if (this.sessionKey(this.readContext()) !== this.key) {
          this.update();
          return;
        }
        pinging = true;
        void peer
          .ping()
          .catch(() => peer.close())
          .finally(() => {
            pinging = false;
          });
      }, 15_000);
      return "authenticated";
    } catch (error) {
      if (this.closed || generation !== this.generation || controller.signal.aborted)
        return "unavailable";
      this.pending = undefined;
      return this.failed(generation, context.session.accessToken, error);
    }
  }

  private retry(generation: number) {
    if (this.timer || this.closed || generation !== this.generation) return;
    this.failures++;
    this.changed(CloudConnectionStatus.RECONNECTING);
    const wait = Math.min(30_000, 500 * 2 ** Math.min(this.failures - 1, 6));
    console.warn(`Server WebSocket disconnected retry_ms=${wait}`);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.sessionKey(this.readContext()) !== this.key) this.update();
        else this.authentication = this.connect(generation);
      },
      wait + Math.floor(Math.random() * Math.min(wait / 4, 1000)),
    );
  }

  canInvoke(route: Route, context: XwapiContext): boolean {
    return !!this.key && this.sessionKey(context) === this.key && !!this.peer?.canInvoke(route);
  }

  async invoke(route: Route, payload: Uint8Array, context: XwapiContext) {
    if (!this.peer || this.sessionKey(context) !== this.key || !this.key)
      throw new Error("connection unavailable");
    const rpc = this.peer.client.invoke(route, payload);
    const cancel = () => rpc.cancel();
    const timeout = context.options?.timeoutMs ?? 15_000;
    const timer = timeout ? setTimeout(cancel, timeout) : undefined;
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    try {
      return await rpc;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
    }
  }

  private stopConnection() {
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
    this.pending?.abort();
    this.pending = undefined;
    this.authentication = undefined;
    const peer = this.peer;
    this.peer = undefined;
    peer?.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.unsubscribe?.();
    this.stopConnection();
  }
}
