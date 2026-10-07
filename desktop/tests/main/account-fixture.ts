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
} from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import { Storage } from "xiaowei-storage";
import { AccountService } from "../../src/main/services/account/service";
import type { AccountStore } from "../../src/main/services/account/store";
import { registerXwapi } from "../../src/main/services/xwapi/gateway";
import { XwapiService } from "../../src/main/services/xwapi/service";

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
    healthResponse: undefined as string | undefined,
    ready: true,
    revoked: false,
    refreshes: 0,
    logins: 0,
    logouts: 0,
    deviceId: "",
    beforeLogin: undefined as (() => Promise<void>) | undefined,
    redirectTo: undefined as string | undefined,
    requests: [] as { path: string; bearer?: string; body: Record<string, unknown> }[],
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
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : {};
    const bearer = request.headers.authorization;
    state.requests.push({ path, bearer, body });
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
      response.end(toJsonString(schema, value, { useProtoFieldName: true, alwaysEmitImplicit: true }));
    };
    const fail = (code: number, msg: string) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code, msg }));
    };

    if (path === "/xiaowei/healthz" || path === "/xiaowei/readyz") {
      if (state.healthResponse !== undefined) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(state.healthResponse);
      } else if (path.endsWith("/readyz") && !state.ready) {
        fail(10008, "数据库暂不可用");
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ code: 0, msg: "成功", data: { status: "ok" } }));
      }
    } else if (path === "/xiaowei/api/auth/login") {
      await state.beforeLogin?.();
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
    } else if (path === "/xiaowei/api/auth/refresh") {
      state.refreshes++;
      if (state.revoked || body.refresh_token !== state.tokens.refreshToken) {
        fail(10002, "登录已失效");
        return;
      }
      rotate();
      send(RefreshResponseSchema, create(RefreshResponseSchema, { msg: "ok", data: state.tokens }));
    } else if (path === "/xiaowei/api/auth/me" || path === "/xiaowei/api/auth/logout") {
      if (state.revoked || !access.has(bearer?.replace(/^Bearer /, "") ?? "")) {
        fail(10002, "登录已失效");
        return;
      }
      if (path.endsWith("/me")) {
        send(
          GetCurrentUserResponseSchema,
          create(GetCurrentUserResponseSchema, {
            msg: "ok",
            data: { user, sessionId: state.tokens.sessionId, device: { deviceId: state.deviceId, deviceName: "test" } },
          }),
        );
      } else {
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
  return {
    state,
    url: `http://127.0.0.1:${address.port}/xiaowei`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function openAccount(
  t: TestContext,
  options: {
    store: AccountStore;
    deviceName: string;
    api?: XwapiService;
    now?: () => number;
  },
  host = new GatewayHost(),
) {
  let service: AccountService | undefined;
  const xwapi = registerXwapi(
    host,
    options.api ?? new XwapiService(fetch, options.now),
    () => service?.serverContext() ?? { server: "" },
  );
  try {
    service = await AccountService.open({
      store: options.store,
      deviceName: options.deviceName,
      now: options.now,
      client: host.client({ caller: "account-main", trusted: true }),
      withServerContext: xwapi.withContext,
    });
  } catch (error) {
    await xwapi.close();
    throw error;
  }
  const account = service;
  t.after(async () => {
    try {
      await account.close();
    } finally {
      await xwapi.close();
    }
  });
  return account;
}
