import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  AccountLoginRequestSchema,
  AccountStatus,
  Auth,
  ErrorCode,
  Health,
  LoginRequestSchema,
  RefreshRequestSchema,
} from "proto-desktop-ts";
import { bindClient, GatewayFailure, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { registerAccountSession, type SessionInput } from "../../src/main/services/account/session";
import { AccountStore } from "../../src/main/services/account/store";
import { accountMeta, authServer, openAccount } from "./account-fixture";
import type { ServerApiContext } from "./server-api-fixture";
import { attachServerApiFixture } from "./server-api-fixture";

const empty = create(EmptySchema);

test("native API uses current context during a concurrent target check", async (t) => {
  const server = await authServer();
  const other = await authServer();
  const host = new GatewayHost();
  const sessions = await registerAccountSession(host);
  let context: SessionInput = { server: server.url };
  let update = () => {};
  sessions.start(
    () => context,
    (listener) => {
      update = listener;
      return () => {};
    },
  );
  t.after(async () => {
    await sessions.close();
    await server.close();
    await other.close();
  });
  const client = host.client({ caller: "ordinary-api-caller", trusted: true });
  const auth = bindClient(Auth, client);
  const health = bindClient(Health, client);
  assert.equal((await health.check(empty)).code, 0);
  const login = await auth.login(
    create(LoginRequestSchema, {
      deviceId: randomUUID(),
      credential: {
        case: "password",
        value: { email: "user@example.test", password: "  sample  " },
      },
    }),
  );
  assert.equal(login.data?.result.case, "authenticated");
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);
  if (login.data?.result.case !== "authenticated") throw new Error("Expected authenticated login");
  context = {
    server: server.url,
    session: { server: server.url, authenticated: login.data.result.value },
  };
  update();
  assert.equal((await auth.getCurrentUser(empty)).code, 0);

  let started = () => {};
  let release = () => {};
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  other.state.beforeHealth = async () => {
    started();
    await blocked;
  };
  const probe = sessions.withServerContext(client, { server: other.url }, async (scoped) => {
    assert.equal((await bindClient(Health, scoped).check(empty)).code, 0);
  });
  try {
    await requested;
    assert.equal((await auth.getCurrentUser(empty)).code, 0);
    assert.equal(server.state.requests.at(-1)?.bearer, `Bearer ${server.state.tokens.accessToken}`);
    assert.equal(other.state.requests.length, 1);
  } finally {
    release();
    await probe;
  }
  assert.equal(other.state.requests.length, 1);
  assert.equal(other.state.requests[0].bearer, undefined);
  assert.equal((await auth.getCurrentUser(empty)).code, 0);
});

test("Gateway rejects missing access and keeps public requests unauthenticated", async (t) => {
  const server = await authServer();
  let now = server.state.now;
  let context: ServerApiContext = { server: server.url };
  const host = new GatewayHost();
  const owner = await attachServerApiFixture(
    host,
    () => context,
    () => now,
  );
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
    {
      server: server.url,
      sessionId: "session",
      accessToken: "",
      accessExpiresAtMs: BigInt(now + 1),
    },
    {
      server: server.url,
      sessionId: "",
      accessToken: "private-access",
      accessExpiresAtMs: BigInt(now + 1),
    },
    {
      server: server.url,
      sessionId: "session",
      accessToken: "private-access",
      accessExpiresAtMs: BigInt(now),
    },
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
      credential: {
        case: "password",
        value: { email: "user@example.test", password: "  sample  " },
      },
    }),
  );
  assert.equal(login.code, 0);
  assert.equal(login.data?.result.case, "authenticated");
  const oldAccess = server.state.tokens.accessToken;
  const refresh = await auth.refresh(
    create(RefreshRequestSchema, { refreshToken: server.state.tokens.refreshToken }),
  );
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

test("raw Auth results leave Account state and persistence with the caller", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xwapi-account-"));
  const server = await authServer();
  const path = join(directory, "auth.json");
  const host = new GatewayHost();
  const account = await openAccount(
    t,
    {
      store: new AccountStore(path, await accountMeta(t, directory)),
      deviceName: "test",
    },
    host,
  );
  await account.addServer(server.url);
  await account.selectServer(server.url);
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
      credential: {
        case: "password",
        value: { email: "user@example.test", password: "  sample  " },
      },
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
  assert.notEqual(
    refreshed.data?.refreshToken,
    JSON.parse(contents).sessions[0].authenticated.tokens.refreshToken,
  );
  assert.deepEqual(account.snapshot(), signedIn);
  assert.equal(await readFile(path, "utf8"), contents);
  assert.equal((await auth.logout(empty)).code, 0);
  assert.deepEqual(account.snapshot(), signedIn);
  assert.equal(changes, before);
  assert.equal(await readFile(path, "utf8"), contents);
  assert.equal(account.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(
    (await auth.getCurrentUser(empty)).code,
    ErrorCode.UNAUTHENTICATED,
    "server still verifies revocation",
  );
});

test("health validates JSON business results; HTTP 200 alone does not mean ready", async (t) => {
  const server = await authServer();
  let context = { server: server.url };
  const host = new GatewayHost();
  const owner = await attachServerApiFixture(host, () => context);
  const client = host.client({ caller: "health-test", trusted: true });
  const health = bindClient(Health, client);
  const auth = bindClient(Auth, client);
  t.after(async () => {
    await owner.close();
    await server.close();
  });
  assert.equal((await health.ready(empty)).code, 0);
  assert.equal(server.state.requests.at(-1)?.path, "/xiaowei/api/common.Health/Ready");
  server.state.ready = false;
  assert.equal((await health.ready(empty)).code, ErrorCode.UNAVAILABLE);
  for (const response of [
    "null",
    "invalid JSON",
    '{"msg":"ok","data":{"status":"ok"}}',
    '{"code":0,"data":{"status":"ok"}}',
    '{"code":0,"msg":"ok"}',
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

test("Login preserves credential fields and binding results without a session", async (t) => {
  const host = new GatewayHost();
  const server = await authServer();
  server.state.loginResponse = JSON.stringify({
    code: 0,
    msg: "continue",
    data: { binding_required: { thirdparty_bind_token: "next-proof", expires_at_ms: "123" } },
  });
  const owner = await attachServerApiFixture(host, () => ({ server: server.url }));
  t.after(() => server.close());
  t.after(() => owner.close());
  const auth = bindClient(Auth, host.client({ caller: "binding-test", trusted: true }));
  const response = await auth.login(
    create(LoginRequestSchema, {
      deviceId: "device",
      thirdpartyBindToken: "binding-proof",
      credential: {
        case: "password",
        value: { email: "user@example.test", password: "  sample  " },
      },
    }),
  );
  assert.deepEqual(server.state.requests[0].body, {
    device_id: "device",
    thirdparty_bind_token: "binding-proof",
    password: { email: "user@example.test", password: "  sample  " },
  });
  assert.equal(server.state.requests[0].bearer, undefined);
  assert.equal(response.data?.result.case, "bindingRequired");
  assert.equal((await auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);
});

test("owner close drains requests, removes routes and is idempotent", async () => {
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
  const owner = await attachServerApiFixture(host, () => ({ server: server.url }));
  const auth = bindClient(Auth, host.client({ caller: "closing-test", trusted: true }));
  const pending = auth.login(create(LoginRequestSchema, { deviceId: randomUUID() }));
  const failed = assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof GatewayFailure && error.detail.code === "OWNER_UNAVAILABLE",
  );
  try {
    await requestStarted;
    const closing = owner.close();
    await Promise.all([closing, owner.close()]);
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

test("Gateway cancellation stops waiting for an in-flight HTTP request", async (t) => {
  const server = await authServer();
  const host = new GatewayHost();
  const owner = await attachServerApiFixture(host, () => ({ server: server.url }));
  const auth = bindClient(Auth, host.client({ caller: "cancel-test", trusted: true }));
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.state.beforeLogin = async () => {
    arrived();
    await blocked;
  };
  t.after(async () => {
    release();
    await owner.close();
    await server.close();
  });
  const request = auth.login(create(LoginRequestSchema, { deviceId: randomUUID() }));
  const rejected = assert.rejects(
    request,
    (error: unknown) => error instanceof GatewayFailure && error.detail.code === "CANCELLED",
  );
  await started;
  request.cancel();
  await rejected;
  assert.equal(server.state.requests.length, 1);
});

test("ordinary Gateway callers cannot inject or retrieve shared session credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-host-context-"));
  const host = new GatewayHost();
  await openAccount(
    t,
    {
      store: new AccountStore(join(directory, "auth.json"), await accountMeta(t, directory)),
      deviceName: "test",
    },
    host,
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caller = host.client({ caller: "ordinary-ui", trusted: true });
  for (const method of ["ReadResult", "Restore", "Release"]) {
    const route = {
      ...methodRoute(Auth.method.login),
      name: `xiaowei.account.session.AccountSession.${method}`,
      input: EmptySchema.typeName,
      output: EmptySchema.typeName,
    };
    await assert.rejects(
      caller.invoke(route, new Uint8Array()),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "UNKNOWN_ROUTE",
    );
  }
});
