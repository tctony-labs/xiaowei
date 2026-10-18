import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  Account,
  AccountChangedSchema,
  AccountLoginRequestSchema,
  AccountLogoutRequestSchema,
  AccountSnapshotSchema,
  AccountStatus,
  AddServerRequestSchema,
  Auth,
  CancelAccountLoginRequestSchema,
  CloudConnectionStatus,
  EmptySchema,
  ErrorCode,
  KvEntrySchema,
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
  assert.deepEqual((await api.get(create(EmptySchema))).servers, ["https://xiaowei.tctony.com"]);
  assert.equal((await api.get(create(EmptySchema))).selectedServer, "https://xiaowei.tctony.com");
  assert.equal(
    (await api.addServer(create(AddServerRequestSchema, { serverAddress: `${server.url}/` }))).code,
    0,
  );
  assert.equal(service.snapshot().selectedServer, "https://xiaowei.tctony.com");
  assert.equal(
    (await api.selectServer(create(SelectServerRequestSchema, { serverAddress: server.url }))).code,
    0,
  );

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
    0,
  );
  assert.equal(
    server.state.requests.find(
      (entry) =>
        entry.path.endsWith("/Login") &&
        (entry.body.password as { password: string }).password === "  sample  ",
    )?.bearer,
    undefined,
  );

  const contents = await readFile(path, "utf8");
  const configuration = JSON.parse(
    (await meta.get(create(KvKeySchema, { key: "account.config" }))).json ?? "",
  );
  assert.deepEqual(configuration.servers, ["https://xiaowei.tctony.com", server.url]);
  assert.equal(configuration.selectedServer, server.url);
  assert.equal(configuration.deviceId, server.state.deviceId);
  assert.deepEqual(Object.keys(JSON.parse(contents)).sort(), ["sessions", "version"]);
  assert.ok(result.snapshot);
  const savedTokens = JSON.parse(contents).sessions[0].authenticated.tokens;
  assert.equal(savedTokens.accessToken, server.state.tokens.accessToken);
  assert.equal(savedTokens.refreshToken, server.state.tokens.refreshToken);
  assert.ok(!contents.includes("  sample  "));
  const snapshot = toJsonString(AccountSnapshotSchema, result.snapshot);
  for (const secret of [
    "  sample  ",
    server.state.tokens.accessToken,
    server.state.tokens.refreshToken,
  ]) {
    assert.ok(!snapshot.includes(secret));
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await owner.close();
  // Existing installations keep their v1 single-server login when upgrading.
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      server: server.url,
      authenticated: JSON.parse(contents).sessions[0].authenticated,
    }),
  );
  // Existing installations may lack the default address; retain their selection and session.
  await meta.set(
    create(KvEntrySchema, {
      key: "account.config",
      json: JSON.stringify({ ...configuration, servers: [server.url] }),
    }),
  );
  const reopened = await openAccount(t, {
    store: new AccountStore(path, meta),
    deviceName: "test",
  });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().servers, [server.url, "https://xiaowei.tctony.com"]);
  assert.equal(reopened.snapshot().selectedServer, server.url);
  assert.equal(reopened.snapshot().status, AccountStatus.RESTORING);
  await reopened.restore();
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(server.state.deviceId, configuration.deviceId);
  assert.equal(server.state.logins, 1);
  assert.equal((await reopened.logout()).code, 0);
  assert.equal(server.state.revoked, true);
  assert.equal(reopened.snapshot().user, undefined);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  const reloaded = await store.load();
  assert.equal(reloaded.deviceId, server.state.deviceId);
  assert.deepEqual(reloaded.servers, [server.url, "https://xiaowei.tctony.com"]);
  assert.ok(events.includes(AccountStatus.SIGNING_IN));
  assert.ok(events.includes(AccountStatus.SIGNED_IN));
});

test("adding checks HTTP without changing the active server or credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-add-check-"));
  const first = await authServer();
  const target = await authServer();
  const path = join(directory, "auth.json");
  const store = new AccountStore(path, await accountMeta(t, directory));
  const host = new GatewayHost();
  const service = await openAccount(t, { store, deviceName: "test" }, host);
  const owner = registerAccount(host, service);
  const api = bindClient(Account, host.client({ caller: "add-server-ui", trusted: true }));
  const add = (serverAddress: string) =>
    api.addServer(create(AddServerRequestSchema, { serverAddress }));
  t.after(async () => {
    await owner.close();
    await first.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await add(`${first.url}/`)).code, 0);
  assert.equal(service.snapshot().selectedServer, "https://xiaowei.tctony.com");
  assert.deepEqual(first.state.requests, [
    { path: "/xiaowei/api/common.Health/Check", bearer: undefined, body: {} },
  ]);
  assert.equal((await add(first.url)).code, ErrorCode.INVALID_ARGUMENT);
  assert.equal((await add("http://remote.example.test")).code, ErrorCode.INVALID_ARGUMENT);
  assert.equal(first.state.requests.length, 1);
  await service.selectServer(first.url);
  assert.equal(
    (
      await service.login(
        create(AccountLoginRequestSchema, {
          serverAddress: first.url,
          password: { email: "user@example.test", password: "  sample  " },
          attemptId: randomUUID(),
        }),
      )
    ).code,
    0,
  );
  const snapshot = service.snapshot();
  const credentials = await readFile(path, "utf8");
  const saved = await store.load();
  const sourceRequests = first.state.requests.length;

  for (const response of ['{"code":10008,"msg":"暂不可用"}', '{"code":0}', "not JSON"]) {
    target.state.healthResponse = response;
    assert.equal((await add(target.url)).code, ErrorCode.UNAVAILABLE);
    assert.deepEqual(service.snapshot(), snapshot);
    assert.deepEqual(await store.load(), saved);
    assert.equal(await readFile(path, "utf8"), credentials);
  }
  target.state.healthResponse = undefined;
  target.state.offline = true;
  assert.equal((await add(target.url)).code, ErrorCode.UNAVAILABLE);
  target.state.offline = false;
  target.state.redirectTo = first.url;
  assert.equal((await add(target.url)).code, ErrorCode.UNAVAILABLE);
  assert.equal(first.state.requests.length, sourceRequests);
  target.state.redirectTo = undefined;
  assert.deepEqual(service.snapshot(), snapshot);

  assert.equal((await add(target.url)).code, 0);
  assert.equal(service.snapshot().selectedServer, first.url);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  assert.deepEqual(service.snapshot().user, snapshot.user);
  assert.equal(await readFile(path, "utf8"), credentials);
  assert.ok(service.snapshot().servers.includes(target.url));
  assert.ok(
    target.state.requests.every(
      (request) => request.path === "/xiaowei/api/common.Health/Check" && !request.bearer,
    ),
  );
});

test("adding preserves caller permissions and cancellation never saves an address", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-add-cancel-"));
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
  const owner = registerAccount(host, service);
  t.after(async () => {
    await owner.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = create(AddServerRequestSchema, { serverAddress: server.url });
  const limited = bindClient(
    Account,
    host.client({
      caller: "limited-add",
      trusted: false,
      invoke: [`${Account.typeName}.AddServer`],
    }),
  );
  const snapshot = service.snapshot();
  assert.equal((await limited.addServer(request)).code, ErrorCode.PERMISSION_DENIED);
  assert.equal(server.state.requests.length, 0);
  assert.deepEqual(service.snapshot(), snapshot);

  let arrived!: () => void;
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.state.beforeHealth = () => {
    arrived();
    return blocked;
  };
  const api = bindClient(Account, host.client({ caller: "add-ui", trusted: true }));
  const adding = api.addServer(request);
  await received;
  assert.deepEqual(service.snapshot(), snapshot);
  adding.cancel();
  await assert.rejects(adding, /RPC cancelled/);
  release();
  await service.selectServer(snapshot.selectedServer);
  assert.deepEqual(service.snapshot(), snapshot);
  assert.equal((await api.addServer(request)).code, 0);
  assert.ok(service.snapshot().servers.includes(server.url));
});

test("switching retains server sessions across restarts, failures and logout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-servers-"));
  const first = await authServer();
  const second = await authServer();
  const path = join(directory, "auth.json");
  const meta = await accountMeta(t, directory);
  const host = new GatewayHost();
  const service = await openAccount(
    t,
    {
      store: new AccountStore(path, meta),
      deviceName: "test",
    },
    host,
  );
  const owner = registerAccount(host, service);
  const api = bindClient(Account, host.client({ caller: "account-switch-ui", trusted: true }));
  t.after(async () => {
    await owner.close();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const server of [first, second]) {
    assert.equal(
      (await api.addServer(create(AddServerRequestSchema, { serverAddress: server.url }))).code,
      0,
    );
  }
  const select = (serverAddress: string) =>
    api.selectServer(create(SelectServerRequestSchema, { serverAddress }));
  const login = (serverAddress: string) =>
    api.login(
      create(AccountLoginRequestSchema, {
        serverAddress,
        password: { email: "user@example.test", password: "  sample  " },
        attemptId: randomUUID(),
      }),
    );
  assert.equal((await select(first.url)).code, 0);
  assert.equal((await login(first.url)).code, 0);
  const original = service.snapshot();
  const failedLogin = await api.login(
    create(AccountLoginRequestSchema, {
      serverAddress: second.url,
      password: { email: "user@example.test", password: "wrong" },
      attemptId: randomUUID(),
    }),
  );
  assert.equal(failedLogin.code, 10100);
  assert.deepEqual(service.snapshot(), original);
  assert.equal(first.state.logouts, 0);
  assert.equal((await login(second.url)).code, 0);
  assert.equal(service.snapshot().selectedServer, second.url);
  assert.equal(service.snapshot().serverAccounts.filter((entry) => entry.user).length, 2);
  const firstToken = first.state.tokens.accessToken;
  const secondToken = second.state.tokens.accessToken;
  assert.notEqual(firstToken, secondToken);
  assert.equal((await select(first.url)).code, 0);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(service.serverContext().session?.accessToken, firstToken);
  assert.equal((await select(second.url)).code, 0);
  assert.equal(service.serverContext().session?.accessToken, secondToken);
  let received!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  second.state.beforeCurrentUser = () => {
    received();
    return blocked;
  };
  assert.equal((await select(first.url)).code, 0);
  const pendingSelection = select(second.url);
  await arrived;
  const latestSelection = select(first.url);
  release();
  await pendingSelection;
  assert.equal((await latestSelection).code, 0);
  assert.equal(service.snapshot().selectedServer, first.url);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  second.state.beforeCurrentUser = undefined;
  second.state.offline = true;
  assert.equal((await select(first.url)).code, 0);
  assert.equal((await select(second.url)).code, 0);
  assert.equal(service.snapshot().status, AccountStatus.OFFLINE);
  assert.equal(service.serverContext().session?.accessToken, secondToken);
  second.state.offline = false;
  second.state.revoked = true;
  assert.equal((await select(first.url)).code, 0);
  assert.equal((await select(second.url)).code, 0);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_OUT);
  assert.equal(service.serverContext().session, undefined);
  assert.equal((await new AccountStore(path, meta).load()).sessions.length, 1);
  assert.equal(first.state.revoked, false);
  assert.equal((await login(second.url)).code, 0);
  const newSecondToken = second.state.tokens.accessToken;
  await owner.close();

  const reopened = await openAccount(t, {
    store: new AccountStore(path, meta),
    deviceName: "test",
  });
  await reopened.restore();
  assert.equal(reopened.snapshot().selectedServer, second.url);
  assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal((await reopened.logout()).code, 0);
  assert.equal(second.state.revoked, true);
  assert.equal(first.state.revoked, false);
  assert.equal((await reopened.selectServer(first.url)).code, 0);
  assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(first.state.logins, 1);
  assert.equal(second.state.logins, 2);
  assert.equal(first.state.logouts, 0);
  assert.equal(second.state.logouts, 1);
  for (const [server, tokens] of [
    [first, [firstToken]],
    [second, [secondToken, newSecondToken]],
  ] as const) {
    for (const request of server.state.requests) {
      if (request.bearer) assert.ok(tokens.some((token) => request.bearer === `Bearer ${token}`));
    }
  }
});

test("new-server login cancellation and save failure preserve the original session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-new-login-"));
  const first = await authServer();
  const second = await authServer();
  const path = join(directory, "auth.json");
  class FaultStore extends AccountStore {
    rejectSelection = "";
    override async save(document: AccountDocument) {
      await super.save(document);
      if (document.selectedServer === this.rejectSelection) {
        throw new AccountError(ErrorCode.INTERNAL_ERROR, "模拟选择保存失败");
      }
    }
  }
  const store = new FaultStore(path, await accountMeta(t, directory));
  const service = await openAccount(t, { store, deviceName: "test" });
  t.after(async () => {
    await service.close();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = (serverAddress: string, attemptId = randomUUID()) =>
    service.login(
      create(AccountLoginRequestSchema, {
        serverAddress,
        password: { email: "user@example.test", password: "  sample  " },
        attemptId,
      }),
    );
  await service.addServer(first.url);
  await service.addServer(second.url);
  assert.equal((await login(first.url)).code, 0);
  const snapshot = service.snapshot();
  const credentials = await readFile(path, "utf8");
  let arrived!: () => void;
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  second.state.beforeLogin = () => {
    arrived();
    return blocked;
  };
  const attemptId = randomUUID();
  const pending = login(second.url, attemptId);
  await received;
  assert.deepEqual(service.snapshot(), snapshot);
  service.cancelLogin(attemptId);
  release();
  assert.notEqual((await pending).code, 0);
  assert.deepEqual(service.snapshot(), snapshot);
  assert.equal(await readFile(path, "utf8"), credentials);
  second.state.beforeLogin = undefined;

  store.rejectSelection = second.url;
  assert.equal((await login(second.url)).code, ErrorCode.INTERNAL_ERROR);
  assert.deepEqual(service.snapshot(), snapshot);
  assert.equal(await readFile(path, "utf8"), credentials);
  assert.equal((await store.load()).selectedServer, first.url);
  assert.equal(second.state.logouts, 1);
  assert.equal(first.state.logouts, 0);
  store.rejectSelection = "";
  assert.equal((await login(second.url)).code, 0);
  assert.equal(service.snapshot().selectedServer, second.url);
  assert.equal(service.snapshot().serverAccounts.filter((entry) => entry.user).length, 2);
});

test("inactive logout refreshes in isolation; logout-all retains failed sessions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-logout-many-"));
  const first = await authServer();
  const second = await authServer();
  class FaultStore extends AccountStore {
    fail = false;
    override async save(document: AccountDocument) {
      if (this.fail) throw new AccountError(ErrorCode.INTERNAL_ERROR, "模拟保存失败");
      return super.save(document);
    }
  }
  const store = new FaultStore(join(directory, "auth.json"), await accountMeta(t, directory));
  let now = first.state.now;
  const host = new GatewayHost();
  const service = await openAccount(t, { store, deviceName: "test", now: () => now }, host);
  const owner = registerAccount(host, service);
  const api = bindClient(Account, host.client({ caller: "manage-ui", trusted: true }));
  t.after(async () => {
    await owner.close();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const server of [first, second]) {
    assert.equal((await service.addServer(server.url)).code, 0);
    assert.equal(
      (
        await api.login(
          create(AccountLoginRequestSchema, {
            serverAddress: server.url,
            password: { email: "user@example.test", password: "  sample  " },
            attemptId: randomUUID(),
          }),
        )
      ).code,
      0,
    );
  }
  const currentSession = service.serverContext().session;
  now += 7_200_000;
  first.state.now = now;
  second.state.now = now;
  store.fail = true;
  const logoutFirst = create(AccountLogoutRequestSchema, { serverAddress: first.url });
  assert.equal((await api.logout(logoutFirst)).code, ErrorCode.INTERNAL_ERROR);
  assert.equal(first.state.refreshes, 1);
  assert.equal(service.snapshot().selectedServer, second.url);
  assert.deepEqual(service.serverContext().session, currentSession);
  store.fail = false;
  assert.equal((await api.logout(logoutFirst)).code, 0);
  assert.equal(
    first.state.refreshes,
    1,
    "retry persists rotated credentials without refreshing again",
  );
  assert.equal(first.state.logouts, 1);
  assert.equal(second.state.refreshes, 0);
  assert.equal(second.state.logouts, 0);
  assert.equal(service.snapshot().selectedServer, second.url);
  assert.equal((await store.load()).sessions.length, 1);

  assert.equal(
    (
      await api.login(
        create(AccountLoginRequestSchema, {
          serverAddress: first.url,
          password: { email: "user@example.test", password: "  sample  " },
          attemptId: randomUUID(),
        }),
      )
    ).code,
    0,
  );
  second.state.offline = true;
  const all = create(AccountLogoutRequestSchema, { allServers: true });
  assert.equal((await api.logout(all)).code, ErrorCode.UNAVAILABLE);
  assert.equal(service.snapshot().selectedServer, first.url);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_OUT);
  const retained = (await store.load()).sessions;
  assert.deepEqual(
    retained.map((entry) => entry.server),
    [second.url],
  );
  assert.equal(
    service.snapshot().serverAccounts.find((entry) => entry.serverAddress === second.url)?.user
      ?.userId,
    "u_testPublicIdentity1234",
  );
  second.state.offline = false;
  assert.equal((await api.logout(all)).code, 0);
  assert.equal((await store.load()).sessions.length, 0);
  assert.equal(service.snapshot().selectedServer, first.url);
  assert.equal(second.state.logouts, 1);
  assert.ok(
    first.state.requests.every(
      (entry) => entry.bearer !== `Bearer ${second.state.tokens.accessToken}`,
    ),
  );
});

test("default WS Logout clears the account before queued connection revalidation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-ws-logout-"));
  const server = await authServer();
  const path = join(directory, "auth.json");
  let ready = false;
  let revalidate = () => Promise.resolve();
  let revalidation: Promise<void> | undefined;
  const wsMethods: string[] = [];
  const httpMethods: string[] = [];
  // Bridge PB replies to the isolated auth fixture; the real socket lifecycle is tested separately.
  const api = new XwapiService(
    (url, options) => {
      httpMethods.push(String(url).split("/").at(-1) ?? "");
      return fetch(url, options);
    },
    Date.now,
    {
      canInvoke: () => ready,
      async invoke(route, _payload, context) {
        wsMethods.push(route.name);
        const method =
          route.name === "auth.Auth/Logout" ? Auth.method.logout : Auth.method.getCurrentUser;
        const response = await fetch(`${server.url}/api/${route.name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${context.session?.accessToken}`,
          },
          body: "{}",
        });
        const bytes = toBinary(method.output, fromJsonString(method.output, await response.text()));
        if (method === Auth.method.logout) {
          ready = false;
          revalidation = revalidate();
        }
        return bytes;
      },
    },
  );
  const service = await openAccount(t, {
    store: new AccountStore(path, await accountMeta(t, directory)),
    deviceName: "test",
    api,
  });
  revalidate = () => service.restore();
  t.after(async () => {
    await service.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.addServer(server.url);
  await service.selectServer(server.url);
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
  ready = true;
  await service.restore();
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal((await service.logout()).code, 0);
  assert.ok(revalidation);
  await revalidation;
  assert.deepEqual(wsMethods, ["auth.Auth/Logout"]);
  assert.equal(httpMethods.includes("GetCurrentUser"), true);
  assert.equal(httpMethods.includes("Logout"), false);
  assert.equal(server.state.logouts, 1);
  assert.equal(server.state.revoked, true);
  assert.equal(service.snapshot().user, undefined);
  assert.equal(service.serverContext().session, undefined);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("invalid saved sessions can be replaced and cleared independently", async (t) => {
  for (const version of [1, 2]) {
    for (const invalid of ["missing-tokens", "wrong-device"]) {
      await t.test(`v${version} ${invalid}`, async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "account-invalid-"));
        const first = await authServer();
        const second = await authServer();
        const path = join(directory, "auth.json");
        const meta = await accountMeta(t, directory);
        const store = new AccountStore(path, meta);
        const initial = await openAccount(t, { store, deviceName: "test" });
        t.after(async () => {
          await first.close();
          await second.close();
          await rm(directory, { recursive: true, force: true });
        });
        const login = (service: typeof initial, serverAddress: string) =>
          service.login(
            create(AccountLoginRequestSchema, {
              serverAddress,
              password: { email: "user@example.test", password: "  sample  " },
              attemptId: randomUUID(),
            }),
          );
        for (const server of version === 1 ? [first] : [first, second]) {
          assert.equal((await initial.addServer(server.url)).code, 0);
          assert.equal((await login(initial, server.url)).code, 0);
        }
        await initial.selectServer(first.url);
        await initial.close();
        const valid = JSON.parse(await readFile(path, "utf8"));
        const broken = structuredClone(valid);
        const entry = broken.sessions.find(
          (session: { server: string }) => session.server === first.url,
        );
        broken.sessions = [
          entry,
          ...broken.sessions.filter((session: { server: string }) => session.server !== first.url),
        ];
        if (invalid === "missing-tokens") delete entry.authenticated.tokens;
        else entry.authenticated.device.deviceId = randomUUID();
        const writeBroken = () =>
          writeFile(path, JSON.stringify(version === 1 ? { version, ...entry } : broken));
        await writeBroken();
        const reopened = await openAccount(t, {
          store: new AccountStore(path, meta),
          deviceName: "test",
        });
        assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_OUT);
        assert.equal(
          reopened.snapshot().serverAccounts.find((entry) => entry.serverAddress === first.url)
            ?.user,
          undefined,
        );
        assert.equal((await login(reopened, first.url)).code, 0);
        assert.equal(reopened.snapshot().status, AccountStatus.SIGNED_IN);
        if (version === 2) {
          assert.equal((await store.load()).sessions.length, 2);
          assert.equal(second.state.logouts, 0);
        }
        await reopened.close();
        await writeBroken();
        const cleanup = await openAccount(t, {
          store: new AccountStore(path, meta),
          deviceName: "test",
        });
        assert.equal(
          (
            await cleanup.logout(
              create(AccountLogoutRequestSchema, {
                allServers: true,
              }),
            )
          ).code,
          0,
        );
        assert.equal((await store.load()).sessions.length, 0);
        if (version === 2) assert.equal(second.state.logouts, 1);
        await cleanup.close();
      });
    }
  }
});

test("WS authentication precedes user lookup and refreshes rejected access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-connection-auth-"));
  const server = await authServer();
  const path = join(directory, "auth.json");
  const meta = await accountMeta(t, directory);
  const store = new AccountStore(path, meta);
  const initial = await openAccount(t, { store, deviceName: "test" });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await initial.addServer(server.url);
  assert.equal(
    (
      await initial.login(
        create(AccountLoginRequestSchema, {
          serverAddress: server.url,
          password: { email: "user@example.test", password: "  sample  " },
          attemptId: randomUUID(),
        }),
      )
    ).code,
    0,
  );
  await initial.close();

  let now = server.state.now;
  let attempts = 0;
  let unavailable = false;
  let rejectNext = false;
  let alwaysReject = false;
  let wsQueries = 0;
  let httpQueries = 0;
  const api = new XwapiService(
    (url, options) => {
      if (String(url).endsWith("/GetCurrentUser")) httpQueries++;
      return fetch(url, options);
    },
    () => now,
    {
      canInvoke: () => !unavailable,
      async invoke(route, _payload, context) {
        assert.equal(route.name, "auth.Auth/GetCurrentUser");
        wsQueries++;
        const response = await fetch(`${server.url}/api/${route.name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${context.session?.accessToken}`,
          },
          body: "{}",
        });
        return toBinary(
          Auth.method.getCurrentUser.output,
          fromJsonString(Auth.method.getCurrentUser.output, await response.text()),
        );
      },
    },
  );
  const restored = await openAccount(t, {
    store: new AccountStore(path, meta),
    deviceName: "test",
    now: () => now,
    api,
    authenticateConnection: async (_client, signal) => {
      signal.throwIfAborted();
      attempts++;
      assert.equal(restored.serverContext().session?.accessToken, server.state.tokens.accessToken);
      if (unavailable) return "unavailable";
      if (rejectNext || alwaysReject) {
        rejectNext = false;
        return "rejected";
      }
      return "authenticated";
    },
  });
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(wsQueries, 1);
  assert.equal(httpQueries, 0);
  assert.equal(attempts, 1);

  restored.setCloudConnection(CloudConnectionStatus.CONNECTED);
  await restored.restore();
  assert.equal(wsQueries, 2, "connection ready merges with an existing restore");
  restored.setCloudConnection(CloudConnectionStatus.CONNECTED);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wsQueries, 2, "repeated ready status does not poll the user again");

  now += 7_200_000;
  server.state.now = now;
  await restored.restore();
  assert.equal(server.state.refreshes, 1);
  assert.equal(wsQueries, 3);
  assert.equal(httpQueries, 0);
  const oldAccess = server.state.tokens.accessToken;
  rejectNext = true;
  await restored.restore();
  assert.equal(server.state.refreshes, 2);
  assert.notEqual(server.state.tokens.accessToken, oldAccess);
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(wsQueries, 4);
  assert.equal(httpQueries, 0);
  await restored.restore(oldAccess);
  assert.equal(server.state.refreshes, 2, "stale rejection cannot refresh the new token");

  unavailable = true;
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(httpQueries, 1, "WS unavailable falls back to HTTP");
  server.state.offline = true;
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.OFFLINE);
  assert.equal((await store.load()).sessions.length, 1);
  await restored.restore(server.state.tokens.accessToken);
  assert.equal(restored.snapshot().status, AccountStatus.OFFLINE);
  assert.equal(
    (await store.load()).sessions.length,
    1,
    "refresh network failure retains credentials",
  );
  server.state.offline = false;
  unavailable = false;
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_IN);

  alwaysReject = true;
  const beforeConfirmation = httpQueries;
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_IN);
  assert.equal(httpQueries, beforeConfirmation + 1, "confirm repeated WS rejection through HTTP");
  alwaysReject = false;
  const valid = await store.load();
  server.state.revoked = true;
  rejectNext = true;
  await restored.restore();
  assert.equal(restored.snapshot().status, AccountStatus.SIGNED_OUT);
  assert.equal((await store.load()).sessions.length, 0);
  await restored.close();

  await store.save(valid);
  const requestsBeforeExpiry = server.state.requests.length;
  const expired = await openAccount(t, {
    store: new AccountStore(path, meta),
    deviceName: "test",
    now: () => Number(valid.sessions[0].authenticated.tokens?.refreshExpiresAtMs) + 1,
    authenticateConnection: async () => assert.fail("Expired refresh must not attempt WS"),
  });
  await expired.restore();
  assert.equal(expired.snapshot().status, AccountStatus.SIGNED_OUT);
  assert.equal(server.state.requests.length, requestsBeforeExpiry);
  assert.equal((await store.load()).sessions.length, 0);
  await expired.close();
});

test("offline retains the session; concurrent restore rotates once; revoked credentials clear", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-refresh-"));
  const server = await authServer();
  let now = server.state.now;
  const store = new AccountStore(join(directory, "auth.json"), await accountMeta(t, directory));
  const service = await openAccount(t, { store, deviceName: "test", now: () => now });
  await service.addServer(server.url);
  await service.selectServer(server.url);
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
      signal: String(url).endsWith("/Login") ? undefined : options?.signal,
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
  await service.selectServer(server.url);
  const owner = registerAccount(host, service);
  const api = bindClient(Account, host.client({ caller: "test", trusted: true }));
  t.after(async () => {
    await owner.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const other = await authServer();
  t.after(() => other.close());
  const target = other.url;
  assert.equal(
    (await api.addServer(create(AddServerRequestSchema, { serverAddress: target }))).code,
    0,
  );
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
  assert.equal(
    server.state.logouts,
    0,
    "a discarded response supplies no credentials for revocation",
  );
  assert.ok(
    server.state.requests.every(
      (entry) =>
        entry.path.startsWith("/xiaowei/api/auth.Auth/") ||
        entry.path === "/xiaowei/api/common.Health/Check",
    ),
  );
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
  server.state.redirectTo = `${otherServer.url}/api/auth.Auth/GetCurrentUser`;
  const http = new XwapiService();
  await assert.rejects(
    http.getCurrentUser({
      server: server.url,
      signal: new AbortController().signal,
      session: {
        server: server.url,
        sessionId: "session",
        accessToken: "private-token",
        accessExpiresAtMs: 2n ** 60n,
      },
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
  const otherServer = await authServer();
  t.after(() => otherServer.close());
  const other = otherServer.url;
  await service.addServer(other);
  await service.addServer(server.url);
  await service.selectServer(server.url);
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
  assert.equal((await service.selectServer(other)).code, ErrorCode.INTERNAL_ERROR);
  assert.equal(service.snapshot().selectedServer, server.url);
  store.fail = false;
  assert.equal((await service.selectServer(other)).code, 0);
  assert.equal((await service.selectServer(server.url)).code, 0);
  assert.equal(server.state.refreshes, 1);
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_IN);
  const saved = (await store.load()).sessions[0];
  assert.equal(saved?.authenticated.tokens?.refreshToken, server.state.tokens.refreshToken);
});

test("received login credentials are revoked through Gateway when saving fails, without becoming public", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "account-uncommitted-"));
  const server = await authServer();
  const host = new GatewayHost();
  class RejectSessionStore extends AccountStore {
    override async save(document: AccountDocument) {
      if (document.sessions.length)
        throw new AccountError(ErrorCode.INTERNAL_ERROR, "模拟凭据保存失败");
      return super.save(document);
    }
  }
  const publicAuth = bindClient(Auth, host.client({ caller: "public-auth", trusted: true }));
  const http = new XwapiService(async (url, options) => {
    if (String(url).endsWith("/Logout")) {
      assert.equal(
        (await publicAuth.getCurrentUser(create(EmptySchema))).code,
        ErrorCode.UNAUTHENTICATED,
      );
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
  await service.selectServer(server.url);
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
  assert.equal(
    (await publicAuth.getCurrentUser(create(EmptySchema))).code,
    ErrorCode.UNAUTHENTICATED,
  );
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
  await service.selectServer(server.url);
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
  assert.equal(server.state.requests.length, 1);
  assert.equal(server.state.requests[0].path, "/xiaowei/api/common.Health/Check");
  assert.equal(service.snapshot().status, AccountStatus.SIGNED_OUT);
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
  const otherServer = await authServer();
  t.after(() => otherServer.close());
  await service.addServer(otherServer.url);
  await service.selectServer(otherServer.url);
  const requests = server.state.requests.length;
  const limitedSwitch = bindClient(
    Account,
    host.client({
      caller: "limited-server-switch",
      trusted: false,
      invoke: [`${Account.typeName}.SelectServer`],
    }),
  );
  const selected = await limitedSwitch.selectServer(
    create(SelectServerRequestSchema, {
      serverAddress: server.url,
    }),
  );
  assert.equal(selected.code, 0);
  assert.equal(selected.snapshot?.status, AccountStatus.OFFLINE);
  assert.equal(server.state.requests.length, requests);
  const limitedLogout = bindClient(
    Account,
    host.client({
      caller: "limited-saved-logout",
      trusted: false,
      invoke: [`${Account.typeName}.Logout`],
    }),
  );
  const beforeLogout = service.snapshot();
  assert.equal(
    (
      await limitedLogout.logout(
        create(AccountLogoutRequestSchema, {
          serverAddress: server.url,
        }),
      )
    ).code,
    ErrorCode.PERMISSION_DENIED,
  );
  assert.deepEqual(service.snapshot(), beforeLogout);
  assert.equal(server.state.requests.length, requests);
});
