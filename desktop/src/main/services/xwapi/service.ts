import { type DescMessage, type DescMethodUnary, fromJson, type MessageShape, toJsonString } from "@bufbuild/protobuf";
import { Auth, BaseResponseSchema, ErrorCode, Health, type TokenPair, type XwApiOptions } from "xiaowei-contracts";
import { normalizeServerAddress } from "../../../shared/server-address";
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

interface HttpMethod {
  method: "GET" | "POST";
  path: string;
  requiresLogin?: false;
}

// Only explicit exceptions bypass the access-session check. Payloads cannot change this policy.
const methods = new Map<DescMethodUnary, HttpMethod>([
  [Auth.method.login, { method: "POST", path: "/api/auth/login", requiresLogin: false }],
  [Auth.method.refresh, { method: "POST", path: "/api/auth/refresh", requiresLogin: false }],
  [Auth.method.getCurrentUser, { method: "GET", path: "/api/auth/me" }],
  [Auth.method.logout, { method: "POST", path: "/api/auth/logout" }],
  [Health.method.check, { method: "GET", path: "/healthz", requiresLogin: false }],
  [Health.method.ready, { method: "GET", path: "/readyz", requiresLogin: false }],
]);

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
    const route = methods.get(method);
    if (!route) throw new XwapiError(ErrorCode.INTERNAL_ERROR, "服务器接口未配置");
    if (context.signal.aborted) throw new XwapiError(ErrorCode.UNAVAILABLE, "服务器请求已取消");

    let token: string | undefined;
    if (route.requiresLogin !== false) {
      const session = context.session;
      let reason: string | undefined;
      if (!session?.sessionId || !session.accessToken) reason = "missing_session";
      else if (session.server !== context.server) reason = "server_mismatch";
      else if (session.accessExpiresAtMs <= BigInt(this.now())) reason = "access_expired";

      if (reason) {
        console.warn(`Xwapi request rejected method=${method.parent.typeName}.${method.name} reason=${reason}`);
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

    try {
      return await this.http.request(
        `${server}${route.path}`,
        schema,
        { method: route.method, logPath: route.path, signal: context.signal, timeoutMs, body, token },
        (value) => {
          if (method === Health.method.check || method === Health.method.ready) {
            // Health HTTP has data.status; the Gateway result needs only code/msg.
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid health response");
            const data = value.data;
            if (!data || typeof data !== "object" || Array.isArray(data) || data.status !== "ok") {
              throw new Error("Invalid health status");
            }
            return fromJson(schema, { code: value.code, msg: value.msg });
          }

          const response = fromJson(schema, value);
          validate(response);
          return response;
        },
      );
    } catch (error) {
      if (error instanceof HttpRequestError && error.outcome === "business_error" && error.code !== undefined) {
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
    return this.request(Auth.method.refresh, Auth.method.refresh.output, context, body, (response) => {
      if (!validTokens(response.data)) throw new Error("Invalid refresh result");
    });
  }

  getCurrentUser(context: XwapiContext) {
    return this.request(
      Auth.method.getCurrentUser,
      Auth.method.getCurrentUser.output,
      context,
      undefined,
      (response) => {
        if (!response.data?.user?.userId || !response.data.device?.deviceId || !response.data.sessionId) {
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
