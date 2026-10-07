import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
import {
  Account,
  AccountChangedSchema,
  AccountLoginRequestSchema,
  AccountSnapshotSchema,
  AccountStatus,
  AddServerRequestSchema,
  Auth,
  CancelAccountLoginRequestSchema,
  EmptySchema,
  ErrorCode,
  KvKeySchema,
  SelectServerRequestSchema,
} from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { AccountError } from "../../src/main/services/account/errors";
import { registerAccount } from "../../src/main/services/account/gateway";
import { type AccountDocument, AccountStore } from "../../src/main/services/account/store";
import { XwapiService } from "../../src/main/services/xwapi/service";
import { accountMeta, authServer, openAccount } from "./account-fixture";

test("Gateway login saves JSON credentials, omits the password and restores the same device", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-runtime-"));
  const server = await authServer();
  const path = join(directory, "auth.json");
  const meta = await accountMeta(t, directory);
  const store = new AccountStore(path, meta);
  const host = new GatewayHost();
  const service = await openAccount(t, { store, deviceName: "test" }, host);
  const owner = registerAccount(host, service);
  t.after(async () => {
    await owner.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = host.client({ caller: "account-ui", trusted: true });
  const api = bindClient(Account, client);
  const events: AccountStatus[] = [];
  const subscription = await client.subscribe(AccountChangedSchema.typeName, undefined, (bytes) => {
    const snapshot = fromBinary(AccountChangedSchema, bytes).snapshot;
    if (snapshot) events.push(snapshot.status);
  });
  t.after(() => subscription.close());
  assert.deepEqual((await api.get(create(EmptySchema))).servers, []);
  assert.equal((await api.get(create(EmptySchema))).selectedServer, "");
  assert.equal((await api.addServer(create(AddServerRequestSchema, { serverAddress: `${server.url}/` }))).code, 0);

  const request = create(AccountLoginRequestSchema, {
    serverAddress: server.url,
    password: { email: "user@example.test", password: "wrong" },
    attemptId: randomUUID(),
  });
  assert.equal((await api.login(request)).code, 10100);
  assert.equal(service.snapshot().user, undefined);
  assert.ok(request.password);
  request.password.password = "  sample  ";
  request.attemptId = randomUUID();
  const result = await api.login(request);
  assert.equal(result.code, 0);
  assert.equal(result.snapshot?.user?.userId, "u_testPublicIdentity1234");
  assert.equal(
    (await api.selectServer(create(SelectServerRequestSchema, { serverAddress: server.url }))).code,
    ErrorCode.INVALID_ARGUMENT,
  );
  assert.equal(
    server.state.requests.find(
      (entry) =>
        entry.path.endsWith("/login") && (entry.body.password as { password: string }).password === "  sample  ",
    )?.bearer,
    undefined,
  );

  const contents = await readFile(path, "utf8");
  const configuration = JSON.parse((await meta.get(create(KvKeySchema, { key: "account.config" }))).json ?? "");
  assert.deepEqual(configuration.servers, [server.url]);
  assert.equal(configuration.selectedServer, server.url);
  assert.equal(configuration.deviceId, server.state.deviceId);
  assert.deepEqual(Object.keys(JSON.parse(contents)).sort(), ["authenticated", "server", "version"]);
  assert.ok(result.snapshot);
  const savedTokens = JSON.parse(contents).authenticated.tokens;
  assert.equal(savedTokens.accessToken, server.state.tokens.accessToken);
  assert.equal(savedTokens.refreshToken, server.state.tokens.refreshToken);
  assert.ok(!contents.includes("  sample  "));
  const snapshot = toJsonString(AccountSnapshotSchema, result.snapshot);
  for (const secret of ["  sample  ", server.state.tokens.accessToken, server.state.tokens.refreshToken]) {
    assert.ok(!snapshot.includes(secret));
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await owner.close();
  const reopened = await openAccount(t, { store: new AccountStore(path, meta), deviceName: "test" });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().status, AccountStatus.RESTORING);
  await reopened.restore();
  assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(server.state.deviceId, configuration.deviceId);
  assert.equal(server.state.logins, 1);
  assert.equal((await reopened.logout()).code, 0);
  assert.equal(server.state.revoked, true);
  assert.equal(reopened.snapshot().user, undefined);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  assert.equal((await store.load()).deviceId, server.state.deviceId);
  assert.ok(events.includes(AccountStatus.SIGNING_IN));
  assert.ok(events.includes(AccountStatus.SIGNED_IN));
});

test("offline retains the session; concurrent restore rotates once; revoked credentials clear", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-refresh-"));
  const server = await authServer();
  let now = server.state.now;
  const store = new AccountStore(join(directory, "auth.json"), await accountMeta(t, directory));
  const service = await openAccount(t, { store, deviceName: "test", now: () => now });
  await service.addServer(server.url);
  t.after(async () => {
    await service.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (
      await service.login(
        create(AccountLoginRequestSchema, {
          serverAddress: server.url,
          password: { email: "user@example.test", password: "  sample  " },
          attemptId: randomUUID(),
        }),
      )
    ).code,
    0,
  );
  server.state.offline = true;
  await service.restore();
  assert.equal(service.snapshot().status, AccountStatus.OFFLINE);
  assert.ok(service.snapshot().user);
  assert.equal((await service.logout()).code, ErrorCode.UNAVAILABLE);
  assert.ok(service.snapshot().user);

  server.state.offline = false;
  now = Number(server.state.tokens.accessExpiresAtMs) - 5 * 60_000 - 1;
  server.state.now = now;
  await service.restore();
  assert.equal(server.state.refreshes, 0);
  now += 1;
  server.state.now = now;
  const first = service.restore();
  const second = service.restore();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(server.state.refreshes, 1);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  server.state.revoked = true;
  await service.restore();
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_OUT);
  assert.equal(service.snapshot().user, undefined);
});

test("switching servers discards cancelled login results; stale cancellation cannot cancel a newer attempt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-switch-"));
  const server = await authServer();
  let release: (() => void) | undefined;
  let received: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.state.beforeLogin = async () => {
    received?.();
    await paused;
  };
  // Deliberately ignore network cancellation. The local RPC still discards the late result.
  const http = new XwapiService((url, options) =>
    fetch(url, {
      ...options,
      signal: String(url).endsWith("/login") ? undefined : options?.signal,
    }),
  );
  const host = new GatewayHost();
  const service = await openAccount(
    t,
    {
      store: new AccountStore(join(directory, "auth.json"), await accountMeta(t, directory)),
      api: http,
      deviceName: "test",
    },
    host,
  );
  await service.addServer(server.url);
  const owner = registerAccount(host, service);
  const api = bindClient(Account, host.client({ caller: "test", trusted: true }));
  t.after(async () => {
    await owner.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const target = "https://other.example.test";
  assert.equal((await api.addServer(create(AddServerRequestSchema, { serverAddress: target }))).code, 0);
  await api.selectServer(create(SelectServerRequestSchema, { serverAddress: server.url }));
  const oldAttempt = randomUUID();
  const login = api.login(
    create(AccountLoginRequestSchema, {
      serverAddress: server.url,
      password: { email: "user@example.test", password: "  sample  " },
      attemptId: oldAttempt,
    }),
  );
  await arrived;
  const selected = api.selectServer(create(SelectServerRequestSchema, { serverAddress: target }));
  release?.();
  assert.notEqual((await login).code, 0);
  assert.equal((await selected).code, 0);
  assert.equal(service.snapshot().selectedServer, target);
  assert.equal(service.snapshot().user, undefined);
  assert.equal(server.state.logouts, 0, "a discarded response supplies no credentials for revocation");
  assert.ok(server.state.requests.every((entry) => entry.path.startsWith("/xiaowei/api/auth/")));
  await api.selectServer(create(SelectServerRequestSchema, { serverAddress: server.url }));
  const newLogin = api.login(
    create(AccountLoginRequestSchema, {
      serverAddress: server.url,
      password: { email: "user@example.test", password: "  sample  " },
      attemptId: randomUUID(),
    }),
  );
  await api.cancelLogin(create(CancelAccountLoginRequestSchema, { attemptId: oldAttempt }));
  assert.equal((await newLogin).code, 0);
});

test("redirect never forwards credentials", async (t) => {
  const server = await authServer();
  t.after(() => server.close());

  const otherServer = await authServer();
  t.after(() => otherServer.close());
  server.state.redirectTo = `${otherServer.url}/api/auth/me`;
  const http = new XwapiService();
  await assert.rejects(
    http.getCurrentUser({
      server: server.url,
      signal: new AbortController().signal,
      session: { server: server.url, sessionId: "session", accessToken: "private-token", accessExpiresAtMs: 2n ** 60n },
    }),
    /无法连接服务器/,
  );
  assert.equal(otherServer.state.requests.length, 0);
  assert.equal(server.state.requests.at(-1)?.bearer, "Bearer private-token");
});

test("rotation retains new tokens on persistence failure and retries saving without replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-persist-"));
  const server = await authServer();
  class FaultStore extends AccountStore {
    fail = false;
    override async save(document: AccountDocument) {
      if (this.fail) throw new AccountError(ErrorCode.INTERNAL_ERROR, "模拟写入失败");
      return super.save(document);
    }
  }
  const store = new FaultStore(join(directory, "auth.json"), await accountMeta(t, directory));
  let now = server.state.now;
  const service = await openAccount(t, { store, deviceName: "test", now: () => now });
  await service.addServer(server.url);
  t.after(async () => {
    await service.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (
      await service.login(
        create(AccountLoginRequestSchema, {
          serverAddress: server.url,
          password: { email: "user@example.test", password: "  sample  " },
          attemptId: randomUUID(),
        }),
      )
    ).code,
    0,
  );
  const oldRefresh = server.state.tokens.refreshToken;
  now += 7_200_000;
  server.state.now = now;
  store.fail = true;
  await service.restore();
  assert.equal(server.state.refreshes, 1);
  assert.notEqual(server.state.tokens.refreshToken, oldRefresh);
  assert.equal(service.snapshot().status, AccountStatus.OFFLINE);
  store.fail = false;
  await service.restore();
  assert.equal(server.state.refreshes, 1);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  const saved = (await store.load()).session;
  assert.equal(saved?.authenticated.tokens?.refreshToken, server.state.tokens.refreshToken);
});

test("received login credentials are revoked through Gateway when saving fails, without becoming public", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-uncommitted-"));
  const server = await authServer();
  const host = new GatewayHost();
  class RejectSessionStore extends AccountStore {
    override async save(document: AccountDocument) {
      if (document.session) throw new AccountError(ErrorCode.INTERNAL_ERROR, "模拟凭据保存失败");
      return super.save(document);
    }
  }
  const publicAuth = bindClient(Auth, host.client({ caller: "public-auth", trusted: true }));
  const http = new XwapiService(async (url, options) => {
    if (String(url).endsWith("/logout")) {
      assert.equal((await publicAuth.getCurrentUser(create(EmptySchema))).code, ErrorCode.UNAUTHENTICATED);
    }
    return fetch(url, options);
  });
  const service = await openAccount(
    t,
    {
      store: new RejectSessionStore(join(directory, "auth.json"), await accountMeta(t, directory)),
      deviceName: "test",
      api: http,
    },
    host,
  );
  await service.addServer(server.url);
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await service.login(
    create(AccountLoginRequestSchema, {
      serverAddress: server.url,
      password: { email: "user@example.test", password: "  sample  " },
      attemptId: randomUUID(),
    }),
  );
  assert.equal(result.code, ErrorCode.INTERNAL_ERROR);
  assert.equal(result.snapshot?.status, AccountStatus.SIGNED_OUT);
  assert.equal(result.snapshot?.user, undefined);
  assert.equal(server.state.logouts, 1);
  assert.equal(server.state.requests.at(-1)?.bearer, `Bearer ${server.state.tokens.accessToken}`);
  assert.equal((await publicAuth.getCurrentUser(create(EmptySchema))).code, ErrorCode.UNAUTHENTICATED);
});

test("Account nested authentication preserves the caller's Gateway permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-permissions-"));
  const server = await authServer();
  const host = new GatewayHost();
  const service = await openAccount(
    t,
    {
      store: new AccountStore(join(directory, "auth.json"), await accountMeta(t, directory)),
      deviceName: "test",
    },
    host,
  );
  await service.addServer(server.url);
  const owner = registerAccount(host, service);
  t.after(async () => {
    await owner.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = bindClient(
    Account,
    host.client({
      caller: "limited-account-ui",
      trusted: false,
      invoke: [`${Account.typeName}.Login`],
    }),
  );
  const result = await api.login(
    create(AccountLoginRequestSchema, {
      serverAddress: server.url,
      password: { email: "user@example.test", password: "  sample  " },
      attemptId: randomUUID(),
    }),
  );
  assert.equal(result.code, ErrorCode.PERMISSION_DENIED);
  assert.equal(server.state.requests.length, 0);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_OUT);
});
