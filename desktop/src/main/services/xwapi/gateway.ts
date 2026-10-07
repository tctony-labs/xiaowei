import { type DescMessage, fromJson, type MessageShape } from "@bufbuild/protobuf";
import { Auth, BaseResponseSchema, ErrorCode, Health, XwApiOptionsSchema } from "xiaowei-contracts";
import { bindHandlers, type Client } from "xiaowei-gateway";
import { type CallContext, contextPermissions, type GatewayHost } from "xiaowei-gateway/host";
import { type XwapiContext, XwapiError, type XwapiService } from "./service";

export function registerXwapi(
  host: GatewayHost,
  service: XwapiService,
  readContext: () => Omit<XwapiContext, "signal">,
) {
  const scopedContexts = new WeakMap<CallContext, Omit<XwapiContext, "signal">>();
  const requests = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function call<S extends DescMessage>(
    schema: S,
    client: Client,
    work: (context: XwapiContext) => Promise<MessageShape<S>>,
  ): Promise<MessageShape<S>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = client.cancellation();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const pending = (async () => {
      try {
        if (closed) throw new XwapiError(ErrorCode.UNAVAILABLE, "服务器接口服务已关闭");
        const context = scopedContexts.get(client.context()) ?? readContext();
        return await work({ ...context, signal: controller.signal, options: client.options(XwApiOptionsSchema) });
      } catch (error) {
        if (!(error instanceof XwapiError)) throw error;
        return fromJson(schema, { code: error.code, msg: error.message });
      }
    })();
    requests.set(controller, pending);
    try {
      return await pending;
    } finally {
      signal.removeEventListener("abort", abort);
      requests.delete(controller);
    }
  }

  const registration = host.registerOwner("xwapi", [
    ...bindHandlers(
      Auth,
      {
        login: (request, client) =>
          call(Auth.method.login.output, client, (context) => service.login(request, context)),
        refresh: (request, client) =>
          call(Auth.method.refresh.output, client, (context) => service.refresh(request, context)),
        getCurrentUser: (_request, client) =>
          call(Auth.method.getCurrentUser.output, client, (context) => service.getCurrentUser(context)),
        logout: (_request, client) => call(Auth.method.logout.output, client, (context) => service.logout(context)),
      },
      { optionsSchema: XwApiOptionsSchema },
    ),
    ...bindHandlers(
      Health,
      {
        check: (_request, client) => call(BaseResponseSchema, client, (context) => service.checkHealth(context)),
        ready: (_request, client) => call(BaseResponseSchema, client, (context) => service.checkReady(context)),
      },
      { optionsSchema: XwApiOptionsSchema },
    ),
  ]);

  return {
    // Host-only scope for Account's uncommitted-session cleanup; never exposed through payload/options.
    async withContext<T>(
      client: Client,
      context: Omit<XwapiContext, "signal">,
      work: (client: Client) => Promise<T>,
    ): Promise<T> {
      const scoped = host.client(contextPermissions(client.context()));
      scopedContexts.set(scoped.context(), context);
      try {
        return await work(scoped);
      } finally {
        scopedContexts.delete(scoped.context());
      }
    },
    close() {
      if (!closing) {
        closed = true;
        registration.close();
        for (const controller of requests.keys()) controller.abort();
        closing = Promise.allSettled(requests.values()).then(() => {});
      }
      return closing;
    },
  };
}
