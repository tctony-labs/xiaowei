import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { create, type DescMessage, type MessageShape, toJsonString } from "@bufbuild/protobuf";
import {
  AuthenticatedSchema,
  GetCurrentUserResponseSchema,
  KeyValue,
  LoginResponseSchema,
  LogoutResponseSchema,
  RefreshResponseSchema,
  TokenPairSchema,
} from "proto-desktop-ts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import { Storage } from "xiaowei-rust";
import { AccountService } from "../../src/main/services/account/service";
import { registerAccountSession } from "../../src/main/services/account/session";
import type { AccountStore } from "../../src/main/services/account/store";
import { attachAuthWebsocket } from "./auth-websocket-fixture";

export async function accountMeta(t: TestContext, directory: string) {
  const database = await Storage.open(join(directory, "storage.sqlite"));
  const host = new GatewayHost();
  const owner = await attachRustNapi(host, "storage", database.createKeyValueGatewayEndpoint());
  t.after(() => owner.close());
  return bindClient(KeyValue, host.client({ caller: "account-test", trusted: true }));
}

export async function authServer() {
  const state = {
    offline: false,
    wsAuthentication: "authenticated" as "authenticated" | "rejected" | "unavailable",
    wsAttempts: 0,
    wsRejectNext: 0,
    beforeAuthentication: undefined as (() => Promise<void>) | undefined,
    beforeLogout: undefined as (() => Promise<void>) | undefined,
    loginResponse: undefined as string | undefined,
    currentUserResponse: undefined as string | undefined,
    logoutResponse: undefined as string | undefined,
    healthStatus: 200,
    healthResponse: undefined as string | undefined,
    ready: true,
    revoked: false,
    refreshes: 0,
    logins: 0,
    logouts: 0,
    deviceId: "",
    beforeLogin: undefined as (() => Promise<void>) | undefined,
    beforeHealth: undefined as (() => Promise<void>) | undefined,
    beforeCurrentUser: undefined as (() => Promise<void>) | undefined,
    redirectTo: undefined as string | undefined,
    requests: [] as {
      path: string;
      bearer?: string;
      body: Record<string, unknown>;
      transport?: string;
    }[],
    tokens: create(TokenPairSchema),
    now: Date.now(),
  };
  const user = { userId: "u_testPublicIdentity1234", email: "user@example.test", createdAtMs: 1n };
  const access = new Set<string>();

  function rotate() {
    state.tokens = create(TokenPairSchema, {
      sessionId: state.tokens.sessionId || `s_${randomUUID()}`,
      accessToken: `access_${randomUUID()}`,
      refreshToken: `refresh_${randomUUID()}`,
      accessExpiresAtMs: BigInt(state.now + 7_200_000),
      refreshExpiresAtMs: BigInt(state.now + 2_592_000_000),
    });
    access.add(state.tokens.accessToken);
  }

  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    if (request.method === "GET") {
      response.writeHead(426);
      response.end();
      return;
    }
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : {};
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    const bearer = request.headers.authorization;
    if (path === "/xiaowei/fixture/authenticate") {
      state.wsAttempts++;
      await state.beforeAuthentication?.();
      response.writeHead(200, { "Content-Type": "application/json" });
      const code = state.offline
        ? "unavailable"
        : state.wsRejectNext > 0
          ? "rejected"
          : state.wsAuthentication;
      if (state.wsRejectNext > 0) state.wsRejectNext--;
      response.end(JSON.stringify({ code }));
      return;
    }
    state.requests.push({
      path,
      bearer,
      body,
      ...(request.headers["x-fixture-transport"] ? { transport: "websocket" } : {}),
    });
    if (state.redirectTo) {
      response.writeHead(302, { Location: state.redirectTo });
      response.end();
      return;
    }
    if (state.offline) {
      response.destroy();
      return;
    }
    const send = <S extends DescMessage>(schema: S, value: MessageShape<S>) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        toJsonString(schema, value, { useProtoFieldName: true, alwaysEmitImplicit: true }),
      );
    };
    const fail = (code: number, msg: string) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code, msg }));
    };

    if (path === "/xiaowei/api/Health/Check" || path === "/xiaowei/api/Health/Ready") {
      await state.beforeHealth?.();
      if (state.healthResponse !== undefined) {
        response.writeHead(state.healthStatus, { "Content-Type": "application/json" });
        response.end(state.healthResponse);
      } else if (path.endsWith("/api/Health/Ready") && !state.ready) {
        fail(10008, "数据库暂不可用");
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ code: 0, msg: "成功", data: {} }));
      }
    } else if (path === "/xiaowei/api/Auth/Login") {
      await state.beforeLogin?.();
      if (state.loginResponse !== undefined) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(state.loginResponse);
        return;
      }
      const password = body.password as { email?: string; password?: string } | undefined;
      if (password?.email !== user.email || password.password !== "  sample  ") {
        fail(10100, "邮箱或密码错误");
        return;
      }
      state.logins++;
      state.revoked = false;
      state.deviceId = String(body.device_id);
      access.clear();
      state.tokens.sessionId = "";
      rotate();
      send(
        LoginResponseSchema,
        create(LoginResponseSchema, {
          msg: "ok",
          data: {
            result: {
              case: "authenticated",
              value: create(AuthenticatedSchema, {
                user,
                tokens: state.tokens,
                device: { deviceId: state.deviceId, deviceName: "test" },
              }),
            },
          },
        }),
      );
    } else if (path === "/xiaowei/api/Auth/Refresh") {
      state.refreshes++;
      if (state.revoked || body.refresh_token !== state.tokens.refreshToken) {
        fail(10002, "登录已失效");
        return;
      }
      rotate();
      send(RefreshResponseSchema, create(RefreshResponseSchema, { msg: "ok", data: state.tokens }));
    } else if (path === "/xiaowei/api/Auth/GetCurrentUser" || path === "/xiaowei/api/Auth/Logout") {
      if (state.revoked || !access.has(bearer?.replace(/^Bearer /, "") ?? "")) {
        fail(10002, "登录已失效");
        return;
      }
      if (path.endsWith("/GetCurrentUser")) {
        await state.beforeCurrentUser?.();
        if (state.currentUserResponse !== undefined) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(state.currentUserResponse);
          return;
        }
        send(
          GetCurrentUserResponseSchema,
          create(GetCurrentUserResponseSchema, {
            msg: "ok",
            data: {
              user,
              sessionId: state.tokens.sessionId,
              device: { deviceId: state.deviceId, deviceName: "test" },
            },
          }),
        );
      } else {
        await state.beforeLogout?.();
        if (state.logoutResponse !== undefined) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(state.logoutResponse);
          return;
        }
        state.logouts++;
        state.revoked = true;
        send(LogoutResponseSchema, create(LogoutResponseSchema, { msg: "ok", data: {} }));
      }
    } else {
      fail(10004, "不存在的接口");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  let websocket: Awaited<ReturnType<typeof attachAuthWebsocket>> | undefined;
  return {
    state,
    enableWebsocket: async () => {
      websocket = await attachAuthWebsocket(server, `http://127.0.0.1:${address.port}/xiaowei`);
    },
    disconnectWebsocket: () => websocket?.disconnect(),
    url: `http://127.0.0.1:${address.port}/xiaowei`,
    close: async () => {
      await websocket?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

export async function openAccount(
  t: TestContext,
  options: {
    store: AccountStore;
    deviceName: string;
    now?: () => number;
  },
  host = new GatewayHost(),
) {
  let service: AccountService;
  const sessions = await registerAccountSession(host, {}, options.now);
  try {
    service = await AccountService.open({
      store: options.store,
      deviceName: options.deviceName,
      now: options.now,
      client: host.client({ caller: "account-main", trusted: true }),
      sessions,
    });
  } catch (error) {
    await sessions.close();
    throw error;
  }
  const account = service;
  sessions.start(
    () => account.sessionContext(),
    (listener) => account.subscribe(listener),
  );
  const closeAccount = account.close.bind(account);
  let closing: Promise<void> | undefined;
  account.close = () => {
    closing ??= closeAccount().finally(async () => {
      await sessions.close();
    });
    return closing;
  };
  t.after(() => account.close());
  return account;
}
