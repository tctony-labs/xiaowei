import { type DescMessage, fromJson, type MessageShape } from "@bufbuild/protobuf";
import { Auth, BaseResponseSchema, ErrorCode, Health } from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import { type XwapiContext, XwapiError, type XwapiService } from "./service";

export function registerXwapi(
  host: GatewayHost,
  service: XwapiService,
  readContext: () => Omit<XwapiContext, "signal">,
) {
  const requests = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function call<S extends DescMessage>(
    schema: S,
    work: (context: XwapiContext) => Promise<MessageShape<S>>,
  ): Promise<MessageShape<S>> {
    const controller = new AbortController();
    const pending = (async () => {
      try {
        if (closed) throw new XwapiError(ErrorCode.UNAVAILABLE, "服务器接口服务已关闭");
        return await work({ ...readContext(), signal: controller.signal });
      } catch (error) {
        if (!(error instanceof XwapiError)) throw error;
        return fromJson(schema, { code: error.code, msg: error.message });
      }
    })();
    requests.set(controller, pending);
    try {
      return await pending;
    } finally {
      requests.delete(controller);
    }
  }

  const registration = host.registerOwner("xwapi", [
    ...bindHandlers(Auth, {
      login: (request) => call(Auth.method.login.output, (context) => service.login(request, context)),
      refresh: (request) => call(Auth.method.refresh.output, (context) => service.refresh(request, context)),
      getCurrentUser: () => call(Auth.method.getCurrentUser.output, (context) => service.getCurrentUser(context)),
      logout: () => call(Auth.method.logout.output, (context) => service.logout(context)),
    }),
    ...bindHandlers(Health, {
      check: () => call(BaseResponseSchema, (context) => service.checkHealth(context)),
      ready: () => call(BaseResponseSchema, (context) => service.checkReady(context)),
    }),
  ]);

  return {
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
