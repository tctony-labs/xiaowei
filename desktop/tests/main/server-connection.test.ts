import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  Auth,
  CloudConnectionStatus,
  ErrorCode,
  Health,
  LoginRequestSchema,
  RefreshRequestSchema,
  type TokenPair,
} from "proto-desktop-ts";
import { bindClient, GatewayFailure } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { registerAccountSession, type SessionInput } from "../../src/main/services/account/session";
import { authServer } from "./account-fixture";

const empty = create(EmptySchema);

async function fixture() {
  const server = await authServer();
  await server.enableWebsocket();
  const host = new GatewayHost();
  let context: SessionInput = { server: server.url };
  let changed: (() => void) | undefined;
  let status = CloudConnectionStatus.DISCONNECTED;
  let revalidations = 0;
  let connectionRevision = 0;
  let configuredRevision = 0;
  const provider = await registerAccountSession(host, {
    changed: (next) => {
      status = next;
      connectionRevision++;
    },
    unauthorized: () => {
      revalidations++;
    },
  });
  provider.start(
    () => context,
    (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  );
  const client = host.client({ caller: "connection-test", trusted: true });
  const auth = bindClient(Auth, client);
  const health = bindClient(Health, client);
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
  if (login.data?.result.case !== "authenticated") throw new Error("Expected authenticated login");
  const authenticated = login.data.result.value;
  context = { server: server.url, session: { server: server.url, authenticated } };
  configuredRevision = connectionRevision;
  changed?.();
  async function waitForStatus(expected: CloudConnectionStatus) {
    const signal = AbortSignal.timeout(5000);
    while (status !== expected || connectionRevision <= configuredRevision) {
      await delay(10, undefined, { signal });
    }
  }
  return {
    server,
    host,
    auth,
    health,
    provider,
    get status() {
      return status;
    },
    get revalidations() {
      return revalidations;
    },
    update(tokens?: TokenPair) {
      context = {
        server: server.url,
        session: tokens && { server: server.url, authenticated: { ...authenticated, tokens } },
      };
      configuredRevision = connectionRevision;
      changed?.();
    },
    waitForStatus,
    ready: () => waitForStatus(CloudConnectionStatus.CONNECTED),
    async close() {
      await provider.close();
      await server.close();
    },
  };
}

test("native connection authenticates, isolates rotations, pauses rejection and closes", {
  timeout: 20_000,
}, async () => {
  const f = await fixture();
  try {
    await f.ready();
    await assert.rejects(
      bindClient(
        Auth,
        f.host.client({ caller: "limited", trusted: false, invoke: [] }),
      ).getCurrentUser(empty),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "UNAUTHORIZED",
    );
    const request = await f.auth.getCurrentUser(empty);
    assert.equal(request.data?.sessionId, f.server.state.tokens.sessionId);
    assert.equal(f.server.state.requests.at(-1)?.transport, "websocket");
    const refreshed = await f.auth.refresh(
      create(RefreshRequestSchema, {
        refreshToken: f.server.state.tokens.refreshToken,
      }),
    );
    assert.equal(refreshed.code, 0);
    f.update(f.server.state.tokens);
    await f.ready();
    f.server.state.wsAuthentication = "rejected";
    f.update({
      ...f.server.state.tokens,
      accessToken: "rejected",
    });
    await f.waitForStatus(CloudConnectionStatus.DISCONNECTED);
    const attempts = f.server.state.wsAttempts;
    await delay(700);
    assert.equal(f.status, CloudConnectionStatus.DISCONNECTED);
    assert.equal(f.revalidations, 1);
    assert.equal(f.server.state.wsAttempts, attempts);
    f.server.state.wsAuthentication = "authenticated";
    f.update(f.server.state.tokens);
    await f.ready();
    f.update();
    await f.waitForStatus(CloudConnectionStatus.DISCONNECTED);
    await f.provider.close();
  } finally {
    await f.close();
  }
});

test("native Gateway selects authenticated WS and keeps public methods on HTTP", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.server.state.currentUserResponse = JSON.stringify({
      code: ErrorCode.UNAVAILABLE,
      msg: "WS response",
    });
    assert.equal((await f.auth.getCurrentUser(empty)).msg, "WS response");
    assert.equal(f.server.state.requests.at(-1)?.transport, "websocket");
    for (const call of [() => f.health.check(empty), () => f.health.ready(empty)]) {
      assert.equal((await call()).code, 0);
      assert.equal(f.server.state.requests.at(-1)?.transport, undefined);
    }
    const refreshed = await f.auth.refresh(
      create(RefreshRequestSchema, { refreshToken: f.server.state.tokens.refreshToken }),
    );
    assert.equal(refreshed.code, 0);
    assert.equal(f.server.state.requests.at(-1)?.transport, undefined);
    f.update();
    assert.equal((await f.auth.getCurrentUser(empty)).code, ErrorCode.UNAUTHENTICATED);
  } finally {
    await f.close();
  }
});

test("WS Logout errors and malformed successes never replay over HTTP", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const body of [
      { code: ErrorCode.UNAVAILABLE, msg: "not ready" },
      { code: 0, msg: "missing data" },
    ]) {
      f.server.state.logoutResponse = JSON.stringify(body);
      const before = f.server.state.requests.length;
      assert.equal((await f.auth.logout(empty)).code, ErrorCode.UNAVAILABLE);
      const sent = f.server.state.requests.slice(before);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].transport, "websocket");
      // The fixture intentionally ends each Logout socket after writing its reply.
      await delay(800);
      await f.ready();
    }
  } finally {
    await f.close();
  }
});
