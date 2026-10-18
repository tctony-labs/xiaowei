import {
  type DescMessage,
  type DescMethodUnary,
  fromBinary,
  fromJson,
  fromJsonString,
  type MessageShape,
  toBinary,
  toJsonString,
} from "@bufbuild/protobuf";
import {
  Auth,
  BaseResponseSchema,
  ErrorCode,
  Health,
  serverApiMethod,
  type TokenPair,
  type XwApiOptions,
  XwApiTransport,
} from "xiaowei-contracts";
import { methodRoute } from "xiaowei-gateway";
import { normalizeServerAddress } from "../../../shared/server-address";
import type { ServerConnection } from "./connection";
import { HttpRequestError, ServerHttpClient } from "./http";

export interface XwapiContext {
  server: string;
  session?: {
    server: string;
    sessionId: string;
    accessToken: string;
    accessExpiresAtMs: bigint;
  };
  signal: AbortSignal;
  options?: XwApiOptions;
}

export class XwapiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class XwapiService {
  private readonly http: ServerHttpClient;

  constructor(
    fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly connection?: Pick<ServerConnection, "canInvoke" | "invoke">,
  ) {
    this.http = new ServerHttpClient(fetcher);
  }

  private async request<S extends DescMessage>(
    method: DescMethodUnary,
    schema: S,
    context: XwapiContext,
    body?: string,
    validate: (response: MessageShape<S>) => void = () => {},
  ): Promise<MessageShape<S>> {
    const timeoutMs = context.options?.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new XwapiError(ErrorCode.INVALID_ARGUMENT, "请求超时时间无效");
    }
    const route = serverApiMethod(method);
    if (context.signal.aborted) throw new XwapiError(ErrorCode.UNAVAILABLE, "服务器请求已取消");

    const transport = context.options?.transport ?? XwApiTransport.UNSPECIFIED;
    if (
      ![XwApiTransport.UNSPECIFIED, XwApiTransport.HTTP, XwApiTransport.WEBSOCKET].includes(
        transport,
      )
    )
      throw new XwapiError(ErrorCode.INVALID_ARGUMENT, "服务器传输方式无效");
    if (transport === XwApiTransport.WEBSOCKET && !route.websocket)
      throw new XwapiError(ErrorCode.INVALID_ARGUMENT, "此接口不支持 WebSocket");

    let token: string | undefined;
    if (route.requiresLogin) {
      const session = context.session;
      let reason: string | undefined;
      if (!session?.sessionId || !session.accessToken) reason = "missing_session";
      else if (session.server !== context.server) reason = "server_mismatch";
      else if (session.accessExpiresAtMs <= BigInt(this.now())) reason = "access_expired";

      if (reason) {
        console.warn(
          `Xwapi request rejected method=${method.parent.typeName}.${method.name} reason=${reason}`,
        );
        throw new XwapiError(ErrorCode.UNAUTHENTICATED, "没有可用的登录凭据，请刷新会话或重新登录");
      }
      token = session?.accessToken;
    }

    let server: string;
    try {
      server = normalizeServerAddress(context.server);
    } catch {
      throw new XwapiError(ErrorCode.INVALID_ARGUMENT, "请先选择有效的服务器地址");
    }

    const wsRoute = { ...methodRoute(method), name: route.id };
    const useWebSocket =
      transport === XwApiTransport.WEBSOCKET ||
      (transport === XwApiTransport.UNSPECIFIED &&
        route.websocket &&
        this.connection?.canInvoke(wsRoute, context));

    if (useWebSocket) {
      if (!this.connection) throw new XwapiError(ErrorCode.UNAVAILABLE, "云连接尚未就绪");
      console.debug(`WebSocket request started method=${method.parent.typeName}.${method.name}`);
      const started = this.now();
      try {
        const response = fromBinary(
          schema,
          await this.connection.invoke(
            wsRoute,
            toBinary(
              method.input,
              body ? fromJsonString(method.input, body) : fromJson(method.input, {}),
            ),
            context,
          ),
        );
        const code = (response as { code?: number }).code;
        if (!Number.isInteger(code)) throw new Error("Invalid WebSocket response");
        if (code === 0) {
          if (!(response as { data?: unknown }).data) throw new Error("Missing response data");
          validate(response);
        }
        console.debug(
          `WebSocket request completed method=${method.parent.typeName}.${method.name} ` +
            `code=${code} duration_ms=${this.now() - started}`,
        );
        return response;
      } catch {
        console.warn(`WebSocket request failed method=${method.parent.typeName}.${method.name}`);
        throw new XwapiError(ErrorCode.UNAVAILABLE, "云连接不可用，请稍后重试");
      }
    }

    try {
      return await this.http.request(
        `${server}${route.path}`,
        schema,
        {
          method: "POST",
          logPath: route.path,
          signal: context.signal,
          timeoutMs,
          body: body ?? "{}",
          token,
        },
        (value) => {
          const response = fromJson(schema, value);
          validate(response);
          return response;
        },
      );
    } catch (error) {
      if (
        error instanceof HttpRequestError &&
        error.outcome === "business_error" &&
        error.code !== undefined
      ) {
        throw new XwapiError(error.code, error.message);
      }
      if (error instanceof HttpRequestError && error.outcome === "protocol_error") {
        throw new XwapiError(ErrorCode.UNAVAILABLE, "服务器返回了无效的响应");
      }
      throw new XwapiError(
        ErrorCode.UNAVAILABLE,
        context.signal.aborted ? "服务器请求已取消" : "无法连接服务器，请稍后重试",
      );
    }
  }

  login(request: MessageShape<typeof Auth.method.login.input>, context: XwapiContext) {
    const body = toJsonString(Auth.method.login.input, request, { useProtoFieldName: true });
    return this.request(Auth.method.login, Auth.method.login.output, context, body, (response) => {
      const result = response.data?.result;
      if (result?.case === "authenticated") {
        if (
          !result.value.user?.userId ||
          !validTokens(result.value.tokens) ||
          result.value.device?.deviceId !== request.deviceId
        ) {
          throw new Error("Invalid authenticated result");
        }
      } else if (result?.case === "bindingRequired") {
        if (!result.value.thirdpartyBindToken || result.value.expiresAtMs <= 0n) {
          throw new Error("Invalid binding result");
        }
      } else {
        throw new Error("Missing login result");
      }
    });
  }

  refresh(request: MessageShape<typeof Auth.method.refresh.input>, context: XwapiContext) {
    if (!request.refreshToken) throw new XwapiError(ErrorCode.INVALID_ARGUMENT, "刷新凭据不能为空");
    const body = toJsonString(Auth.method.refresh.input, request, { useProtoFieldName: true });
    return this.request(
      Auth.method.refresh,
      Auth.method.refresh.output,
      context,
      body,
      (response) => {
        if (!validTokens(response.data)) throw new Error("Invalid refresh result");
      },
    );
  }

  getCurrentUser(context: XwapiContext) {
    return this.request(
      Auth.method.getCurrentUser,
      Auth.method.getCurrentUser.output,
      context,
      undefined,
      (response) => {
        if (
          !response.data?.user?.userId ||
          !response.data.device?.deviceId ||
          !response.data.sessionId
        ) {
          throw new Error("Invalid account information");
        }
      },
    );
  }

  logout(context: XwapiContext) {
    return this.request(Auth.method.logout, Auth.method.logout.output, context);
  }

  checkHealth(context: XwapiContext) {
    return this.request(Health.method.check, BaseResponseSchema, context);
  }

  checkReady(context: XwapiContext) {
    return this.request(Health.method.ready, BaseResponseSchema, context);
  }
}

function validTokens(tokens: TokenPair | undefined) {
  return (
    tokens?.accessToken &&
    tokens.refreshToken &&
    tokens.sessionId &&
    tokens.accessExpiresAtMs > 0n &&
    tokens.refreshExpiresAtMs > 0n
  );
}
