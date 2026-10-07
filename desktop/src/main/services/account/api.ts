import type { DescMessage } from "@bufbuild/protobuf";
import { create, type MessageShape, toJsonString } from "@bufbuild/protobuf";
import {
  ErrorCode,
  GetCurrentUserResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  type PasswordLogin,
  RefreshRequestSchema,
  RefreshResponseSchema,
} from "xiaowei-contracts";
import { normalizeServerAddress } from "../../../shared/server-address";
import { HttpRequestError, ServerHttpClient } from "../../http/client";
import { AccountError } from "./errors";

export class AuthHttpClient {
  private readonly client: ServerHttpClient;

  constructor(fetcher: typeof fetch = fetch) {
    this.client = new ServerHttpClient(fetcher);
  }

  private async request<S extends DescMessage>(
    server: string,
    path: string,
    schema: S,
    signal: AbortSignal,
    options: { body?: string; token?: string } = {},
  ): Promise<MessageShape<S>> {
    try {
      return await this.client.request(`${normalizeServerAddress(server)}/api/auth/${path}`, schema, {
        method: options.body === undefined && path === "me" ? "GET" : "POST",
        logPath: `/api/auth/${path}`,
        signal,
        ...options,
      });
    } catch (error) {
      if (error instanceof HttpRequestError && error.outcome === "business_error" && error.code !== undefined) {
        throw new AccountError(error.code, error.message);
      }
      if (error instanceof HttpRequestError && error.outcome === "protocol_error") {
        throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无效的响应");
      }
      throw new AccountError(ErrorCode.UNAVAILABLE, signal.aborted ? "登录操作已取消" : "无法连接服务器，请稍后重试");
    }
  }

  async login(server: string, deviceId: string, deviceName: string, password: PasswordLogin, signal: AbortSignal) {
    const body = toJsonString(
      LoginRequestSchema,
      create(LoginRequestSchema, {
        deviceId,
        deviceName,
        credential: { case: "password", value: password },
      }),
      { useProtoFieldName: true },
    );
    const response = await this.request(server, "login", LoginResponseSchema, signal, { body });
    const result = response.data?.result;
    if (
      result?.case !== "authenticated" ||
      !result.value.user?.userId ||
      !result.value.tokens?.accessToken ||
      !result.value.tokens.refreshToken ||
      !result.value.tokens.sessionId ||
      result.value.tokens.accessExpiresAtMs <= 0n ||
      result.value.tokens.refreshExpiresAtMs <= 0n ||
      result.value.device?.deviceId !== deviceId
    ) {
      throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无效的登录结果");
    }
    return result.value;
  }

  async refresh(server: string, refreshToken: string, signal: AbortSignal) {
    const body = toJsonString(RefreshRequestSchema, create(RefreshRequestSchema, { refreshToken }), {
      useProtoFieldName: true,
    });
    const response = await this.request(server, "refresh", RefreshResponseSchema, signal, { body });
    if (
      !response.data?.accessToken ||
      !response.data.refreshToken ||
      !response.data.sessionId ||
      response.data.accessExpiresAtMs <= 0n ||
      response.data.refreshExpiresAtMs <= 0n
    ) {
      throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无效的刷新结果");
    }
    return response.data;
  }

  async me(server: string, token: string, signal: AbortSignal) {
    const response = await this.request(server, "me", GetCurrentUserResponseSchema, signal, { token });
    if (!response.data?.user?.userId || !response.data.device?.deviceId || !response.data.sessionId) {
      throw new AccountError(ErrorCode.UNAVAILABLE, "服务器返回了无效的账号信息");
    }
    return response.data;
  }

  async logout(server: string, token: string, signal: AbortSignal) {
    await this.request(server, "logout", LogoutResponseSchema, signal, { token });
  }
}
