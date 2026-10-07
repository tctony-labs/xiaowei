import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  AccountLoginRequestSchema,
  AccountStatus,
  Auth,
  EmptySchema,
  ErrorCode,
  Health,
  LoginRequestSchema,
  RefreshRequestSchema,
  XwApiOptionsSchema,
} from "xiaowei-contracts";
import { bindClient, GatewayFailure } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { AccountStore } from "../../src/main/services/account/store";
import { registerXwapi } from "../../src/main/services/xwapi/gateway";
import { type XwapiContext, XwapiService } from "../../src/main/services/xwapi/service";
import { accountMeta, authServer, openAccount } from "./account-fixture";

const empty = create(EmptySchema);

test("Gateway checks access locally, and explicitly public methods never attach a bearer", async (t) => {
  const server = await authServer();
  let now = server.state.now;
  let context: Omit<XwapiContext, "signal"> = { server: server.url };
  const host = new GatewayHost();
  const owner = registerXwapi(host, new XwapiService(fetch, () => now), () => context);
  const client = host.client({ caller: "xwapi-test", trusted: true });
  const auth = bindClient(Auth, client);
  const health = bindClient(Health, client);
  t.after(async () => {
    await owner.close();
    await server.close();
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "debug", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));

  for (const session of [
    undefined,
    { server: server.url, sessionId: "session", accessToken: "", accessExpiresAtMs: BigInt(now + 1) },
    { server: server.url, sessionId: "", accessToken: "private-access", accessExpiresAtMs: BigInt(now + 1) },
    { server: server.url, sessionId: "session", accessToken: "private-access", accessExpiresAtMs: BigInt(now) },
    {
      server: "https://other.example.test",
      sessionId: "session",
      accessToken: "private-access",
      accessExpiresAtMs: BigInt(now + 1),
    },
  ]) {
    context = { server: server.url, session };
    for (const call of [() => auth.getCurrentUser(empty), () => auth.logout(empty)]) {
      const response = await call();
      assert.equal(response.code, ErrorCode.UNAUTHENTICATED);
      assert.equal(response.data, undefined);
    }
  }
  assert.equal(server.state.requests.length, 0);
  assert.ok(!JSON.stringify(logs).includes("HTTP request started"));
  assert.ok(!JSON.stringify(logs).includes("private-access"));
  context = { server: server.url };
  assert.equal((await health.check(empty)).code, 0);
  assert.equal((await health.ready(empty)).code, 0);
  const login = await auth.login(
    create(LoginRequestSchema, {
      deviceId: randomUUID(),
      credential: { case: "password", value: { email: "user@example.test", password: "  sample  " } },
    }),
  );
  assert.equal(login.code, 0);
  assert.equal(login.data?.result.case, "authenticated");
  const oldAccess = server.state.tokens.accessToken;
  const refresh = await auth.refresh(create(RefreshRequestSchema, { refreshToken: server.state.tokens.refreshToken }));
  assert.equal(refresh.code, 0);
  assert.notEqual(refresh.data?.accessToken, oldAccess);
  assert.ok(server.state.requests.every((request) => request.bearer === undefined));
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);

  context = {
    server: server.url,
    session: { server: server.url, ...server.state.tokens },
  };
  // Public methods omit bearer credentials even when a valid session is available.
  assert.equal((await health.check(empty)).code, 0);
  assert.equal(server.state.requests.at(-1)?.bearer, undefined);
  const me = await auth.getCurrentUser(empty);
  assert.equal(me.data?.sessionId, server.state.tokens.sessionId);
  assert.equal(server.state.requests.at(-1)?.bearer, `Bearer ${server.state.tokens.accessToken}`);
  now = Number(server.state.tokens.accessExpiresAtMs);
  const count = server.state.requests.length;
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);
  assert.equal(server.state.requests.length, count);
  assert.equal(server.state.refreshes, 1, "xwapi must not automatically refresh expired access");
});

test("raw authentication responses leave Account state and persisted credentials with the caller", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xwapi-account-"));
  const server = await authServer();
  const path = join(directory, "auth.json");
  const api = new XwapiService();
  const host = new GatewayHost();
  const account = await openAccount(
    t,
    {
      store: new AccountStore(path, await accountMeta(t, directory)),
      deviceName: "test",
      api,
    },
    host,
  );
  await account.addServer(server.url);
  const auth = bindClient(Auth, host.client({ caller: "raw-auth-test", trusted: true }));
  t.after(async () => {
    await account.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  let changes = 0;
  account.subscribe(() => changes++);
  const snapshot = account.snapshot();
  const login = await auth.login(
    create(LoginRequestSchema, {
      deviceId: randomUUID(),
      credential: { case: "password", value: { email: "user@example.test", password: "  sample  " } },
    }),
  );
  assert.equal(login.code, 0);
  assert.deepEqual(account.snapshot(), snapshot);
  assert.equal(changes, 0);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);

  const managed = await account.login(
    create(AccountLoginRequestSchema, {
      serverAddress: server.url,
      password: { email: "user@example.test", password: "  sample  " },
      attemptId: randomUUID(),
    }),
  );
  assert.equal(managed.code, 0);
  const signedIn = account.snapshot();
  const contents = await readFile(path, "utf8");
  const before = changes;
  const refreshed = await auth.refresh(
    create(RefreshRequestSchema, { refreshToken: server.state.tokens.refreshToken }),
  );
  assert.equal(refreshed.code, 0);
  assert.notEqual(refreshed.data?.refreshToken, JSON.parse(contents).authenticated.tokens.refreshToken);
  assert.deepEqual(account.snapshot(), signedIn);
  assert.equal(await readFile(path, "utf8"), contents);
  assert.equal((await auth.logout(empty)).code, 0);
  assert.deepEqual(account.snapshot(), signedIn);
  assert.equal(changes, before);
  assert.equal(await readFile(path, "utf8"), contents);
  assert.equal(account.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED, "server still verifies revocation");
});

test("health validates JSON business results; HTTP 200 alone does not mean ready", async (t) => {
  const server = await authServer();
  let context = { server: server.url };
  const host = new GatewayHost();
  const owner = registerXwapi(host, new XwapiService(), () => context);
  const client = host.client({ caller: "health-test", trusted: true });
  const health = bindClient(Health, client);
  const auth = bindClient(Auth, client);
  t.after(async () => {
    await owner.close();
    await server.close();
  });
  assert.equal((await health.ready(empty)).code, 0);
  assert.equal(server.state.requests.at(-1)?.path, "/xiaowei/readyz");
  server.state.ready = false;
  assert.equal((await health.ready(empty)).code, ErrorCode.UNAVAILABLE);
  for (const response of [
    "null",
    "invalid JSON",
    '{"msg":"ok","data":{"status":"ok"}}',
    '{"code":0,"data":{"status":"ok"}}',
    '{"code":0,"msg":"ok"}',
    '{"code":0,"msg":"ok","data":{}}',
    '{"code":0,"msg":"ok","data":{"status":"wrong"}}',
    '{"code":2147483648,"msg":"invalid code"}',
  ]) {
    server.state.healthResponse = response;
    assert.equal((await health.check(empty)).code, ErrorCode.UNAVAILABLE);
  }
  server.state.healthResponse = '{"code":10999,"msg":"unknown failure"}';
  const failure = await health.check(empty);
  assert.equal(failure.code, 10999);
  assert.equal(failure.msg, "unknown failure");
  assert.equal((await auth.refresh(create(RefreshRequestSchema))).code, ErrorCode.INVALID_ARGUMENT);
  const count = server.state.requests.length;
  context = { server: "" };
  assert.equal((await health.check(empty)).code, ErrorCode.INVALID_ARGUMENT);
  assert.equal(server.state.requests.length, count);
});

test("login forwards credential fields and preserves binding results without establishing a session", async (t) => {
  const host = new GatewayHost();
  const api = new XwapiService(async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), {
      device_id: "device",
      thirdparty_bind_token: "binding-proof",
      password: { email: "user@example.test", password: "  sample  " },
    });
    assert.equal(new Headers(options?.headers).get("Authorization"), null);
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "continue",
        data: { binding_required: { thirdparty_bind_token: "next-proof", expires_at_ms: "123" } },
      }),
    );
  });
  const owner = registerXwapi(host, api, () => ({ server: "https://example.test" }));
  t.after(() => owner.close());
  const auth = bindClient(Auth, host.client({ caller: "binding-test", trusted: true }));
  const response = await auth.login(
    create(LoginRequestSchema, {
      deviceId: "device",
      thirdpartyBindToken: "binding-proof",
      credential: { case: "password", value: { email: "user@example.test", password: "  sample  " } },
    }),
  );
  assert.equal(response.data?.result.case, "bindingRequired");
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);
});

test("owner close aborts and drains a real request, is idempotent, and removes routes", async () => {
  const server = await authServer();
  let arrived!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.state.beforeLogin = async () => {
    arrived();
    await paused;
  };
  const host = new GatewayHost();
  const owner = registerXwapi(host, new XwapiService(), () => ({ server: server.url }));
  const auth = bindClient(Auth, host.client({ caller: "closing-test", trusted: true }));
  const pending = auth.login(create(LoginRequestSchema, { deviceId: randomUUID() }));
  const failed = assert.rejects(
    pending,
    (error: unknown) => error instanceof GatewayFailure && error.detail.code === "OWNER_UNAVAILABLE",
  );
  try {
    await requestStarted;
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await closing;
    await failed;
    await assert.rejects(
      auth.getCurrentUser(empty),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "UNKNOWN_ROUTE",
    );
  } finally {
    release();
    await owner.close();
    await server.close();
  }
});

test("xwapi applies a small timeout from independent Gateway options", async (t) => {
  const server = await authServer();
  const host = new GatewayHost();
  const owner = registerXwapi(host, new XwapiService(), () => ({ server: server.url }));
  const auth = bindClient(Auth, host.client({ caller: "timeout-test", trusted: true }), {
    optionsSchema: XwApiOptionsSchema,
  });
  let release!: () => void;
  server.state.beforeLogin = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const logs: string[] = [];
  t.mock.method(console, "debug", (text: string) => logs.push(text));
  t.mock.method(console, "error", (text: string) => logs.push(text));
  try {
    const result = await auth.login(
      create(LoginRequestSchema, {
        deviceId: randomUUID(),
        credential: { case: "password", value: { email: "user@example.test", password: "  sample  " } },
      }),
      { timeoutMs: 50 },
    );
    assert.equal(result.code, ErrorCode.UNAVAILABLE);
    assert.equal(result.data, undefined);
    assert.ok(logs.some((text) => text.includes("timeout_ms=50")));
    assert.equal(server.state.requests.length, 1);
    const completed = logs.find((text) => text.includes("HTTP request completed"));
    assert.ok(Number(completed?.match(/duration_ms=(\d+)/)?.[1]) >= 40);
  } finally {
    release?.();
    await owner.close();
    await server.close();
  }
});

test("xwapi defaults to 15000 and zero omits the HTTP timeout signal", async (t) => {
  const durations: number[] = [];
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    durations.push(duration);
    return original(duration);
  });
  const host = new GatewayHost();
  const owner = registerXwapi(
    host,
    new XwapiService(async () => new Response(JSON.stringify({ code: 0, msg: "ok", data: { status: "ok" } }))),
    () => ({ server: "https://example.test" }),
  );
  const health = bindClient(Health, host.client({ caller: "default-timeout", trusted: true }), {
    optionsSchema: XwApiOptionsSchema,
  });
  try {
    assert.equal((await health.check(empty)).code, 0);
    assert.deepEqual(durations, [15_000]);
    assert.equal((await health.check(empty, { timeoutMs: 0 })).code, 0);
    assert.deepEqual(durations, [15_000]);
    assert.equal((await health.check(empty, { timeoutMs: 2_147_483_648 })).code, ErrorCode.INVALID_ARGUMENT);
  } finally {
    await owner.close();
  }
});
