import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  Auth,
  CloudConnectionStatus,
  EmptySchema,
  EnvelopeSchema,
  ErrorCode,
  Fixture,
  XwApiOptionsSchema,
  XwApiTransport,
} from "xiaowei-contracts";
import { methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { ServerConnection } from "../../src/main/services/xwapi/connection";
import { type XwapiContext, XwapiError, XwapiService } from "../../src/main/services/xwapi/service";

const directory = mkdtempSync(join(tmpdir(), "xw-connection-"));
let fixture: ChildProcess;
let server: string;
before(async () => {
  execFileSync(
    "go",
    ["build", "-o", join(directory, "fixture"), "./internal/gateway/testfixture"],
    { cwd: new URL("../../../server", import.meta.url), stdio: "inherit", timeout: 120_000 },
  );
  fixture = spawn(join(directory, "fixture"), [], { stdio: ["pipe", "pipe", "inherit"] });
  const stdout = fixture.stdout;
  assert.ok(stdout);
  server = await new Promise<string>((resolve, reject) => {
    const reader = createInterface({ input: stdout });
    const timer = setTimeout(() => reject(new Error("fixture startup timed out")), 5000);
    reader.once("line", (line) => {
      clearTimeout(timer);
      reader.close();
      resolve(line.replace("ws:", "http:"));
    });
    fixture.once("error", reject);
  });
});
after(() => {
  fixture?.stdin?.end();
  fixture?.kill();
  rmSync(directory, { recursive: true, force: true });
});

test("committed session connects; rotation, logout and retry isolate old connections", {
  timeout: 10_000,
}, async () => {
  let context: Omit<XwapiContext, "signal"> = { server };
  let changed: (() => void) | undefined;
  let status = CloudConnectionStatus.DISCONNECTED;
  let revalidations = 0;
  let connected!: () => void;
  const nextConnection = () =>
    new Promise<void>((resolve) => {
      connected = resolve;
    });
  const manager = new ServerConnection(
    new GatewayHost(),
    () => context,
    (next) => {
      status = next;
      if (next === CloudConnectionStatus.CONNECTED) connected?.();
    },
    () => {
      revalidations++;
    },
  );
  manager.start((listener) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  });
  try {
    const echo = methodRoute(Fixture.method.echo);
    assert.equal(manager.canInvoke(echo, { ...context, signal: AbortSignal.timeout(5000) }), false);
    const first = nextConnection();
    context = {
      server,
      session: {
        server,
        sessionId: "first",
        accessToken: "fixture",
        accessExpiresAtMs: BigInt(Date.now() + 60_000),
      },
    };
    changed?.();
    assert.equal(manager.canInvoke(echo, { ...context, signal: AbortSignal.timeout(5000) }), false);
    await first;
    const request = toBinary(EnvelopeSchema, create(EnvelopeSchema, { text: "roundtrip", id: 7n }));
    const callContext = () => ({ ...context, signal: new AbortController().signal });
    assert.equal(manager.canInvoke(echo, callContext()), true);
    assert.equal(manager.canInvoke({ ...echo, name: "missing.Method" }, callContext()), false);
    assert.equal(manager.canInvoke({ ...echo, output: "wrong.Output" }, callContext()), false);
    const currentSession = context.session;
    assert.ok(currentSession);
    for (const session of [
      undefined,
      { ...currentSession, server: "http://other.test" },
      { ...currentSession, sessionId: "other" },
      { ...currentSession, accessToken: "other" },
      { ...currentSession, accessExpiresAtMs: 1n },
    ]) {
      assert.equal(manager.canInvoke(echo, { ...callContext(), session }), false);
    }
    const response = await manager.invoke(methodRoute(Fixture.method.echo), request, callContext());
    assert.equal(fromBinary(EnvelopeSchema, response).id, 7n);

    const reconnected = nextConnection();
    await assert.rejects(
      manager.invoke(
        methodRoute(Fixture.method.echo),
        toBinary(EnvelopeSchema, create(EnvelopeSchema, { text: "disconnect" })),
        callContext(),
      ),
    );
    await reconnected;
    assert.equal(status, CloudConnectionStatus.CONNECTED);
    assert.equal(revalidations, 0);

    const previous = callContext();
    const rotated = nextConnection();
    context = {
      ...context,
      session: {
        ...(context.session ??
          (() => {
            throw new Error("missing session");
          })()),
        sessionId: "second",
      },
    };
    changed?.();
    assert.equal(manager.canInvoke(echo, previous), false);
    await assert.rejects(manager.invoke(methodRoute(Fixture.method.echo), request, previous));
    await rotated;
    assert.equal(
      fromBinary(
        EnvelopeSchema,
        await manager.invoke(methodRoute(Fixture.method.echo), request, callContext()),
      ).id,
      7n,
    );

    // Auth failure schedules a bounded retry without clearing the committed login context.
    context = {
      ...context,
      session: {
        ...(context.session ??
          (() => {
            throw new Error("missing session");
          })()),
        accessToken: "rejected",
      },
    };
    changed?.();
    const deadline = Date.now() + 2000;
    while (
      (status !== CloudConnectionStatus.RECONNECTING || revalidations === 0) &&
      Date.now() < deadline
    ) {
      await delay(10);
    }
    assert.equal(status, CloudConnectionStatus.RECONNECTING);
    assert.equal(manager.canInvoke(echo, callContext()), false);
    assert.equal(revalidations, 1);
    assert.ok(context.session);
    const restored = nextConnection();
    context = {
      ...context,
      session: {
        ...(context.session ??
          (() => {
            throw new Error("missing session");
          })()),
        accessToken: "fixture",
      },
    };
    changed?.();
    await restored;
    context = { server };
    changed?.();
    assert.equal(status, CloudConnectionStatus.DISCONNECTED);
    assert.equal(manager.canInvoke(echo, callContext()), false);
    await assert.rejects(manager.invoke(methodRoute(Fixture.method.echo), request, callContext()));
    manager.close();
    assert.equal(changed, undefined);
  } finally {
    manager.close();
  }
});

test("explicit WS requires login and readiness, preserves PB errors, and never falls back to HTTP", {
  timeout: 10_000,
}, async () => {
  let http = 0;
  let ws = 0;
  const service = new XwapiService(
    async () => {
      http++;
      throw new Error("HTTP should not run");
    },
    Date.now,
    {
      canInvoke: () => true,
      async invoke(route) {
        ws++;
        const method =
          route.name === "auth.Auth/Logout" ? Auth.method.logout : Auth.method.getCurrentUser;
        assert.equal(route.name, `auth.Auth/${method.name}`);
        assert.equal(route.input, "xiaowei.common.Empty");
        assert.equal(route.output, method.output.typeName);
        return toBinary(
          method.output,
          create(method.output, {
            code: ErrorCode.UNAVAILABLE,
            msg: "not ready",
          }),
        );
      },
    },
  );
  const context: XwapiContext = {
    server,
    signal: new AbortController().signal,
    options: create(XwApiOptionsSchema, { transport: XwApiTransport.WEBSOCKET }),
  };
  await assert.rejects(
    service.getCurrentUser(context),
    (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.UNAUTHENTICATED,
  );
  context.session = {
    server,
    sessionId: "session",
    accessToken: "fixture",
    accessExpiresAtMs: BigInt(Date.now() + 60_000),
  };
  const response = await service.getCurrentUser(context);
  assert.equal(response.code, ErrorCode.UNAVAILABLE);
  await assert.rejects(
    service.checkHealth(context),
    (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.INVALID_ARGUMENT,
  );
  assert.equal((await service.logout(context)).code, ErrorCode.UNAVAILABLE);
  for (const call of [
    () => service.login(create(Auth.method.login.input), context),
    () => service.refresh(create(Auth.method.refresh.input, { refreshToken: "test" }), context),
    () => service.checkHealth(context),
    () => service.checkReady(context),
  ]) {
    await assert.rejects(
      call(),
      (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.INVALID_ARGUMENT,
    );
  }
  assert.equal(http, 0);
  assert.equal(ws, 2);
  const disconnected = new XwapiService();
  await assert.rejects(
    disconnected.getCurrentUser(context),
    (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.UNAVAILABLE,
  );
  const malformed = new XwapiService(undefined, Date.now, {
    canInvoke: () => true,
    async invoke() {
      return toBinary(Auth.method.logout.output, create(Auth.method.logout.output, { msg: "ok" }));
    },
  });
  await assert.rejects(
    malformed.logout(context),
    (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.UNAVAILABLE,
  );
  assert.equal(Auth.method.getCurrentUser.input, EmptySchema);
});

test("default prefers ready WS; HTTP and public methods bypass selection", async () => {
  let available = true;
  let probes = 0;
  let http = 0;
  let ws = 0;
  const service = new XwapiService(
    async (_url, init) => {
      http++;
      assert.equal(init?.method, "POST");
      return Response.json({ code: ErrorCode.UNAVAILABLE, msg: "HTTP response" });
    },
    Date.now,
    {
      canInvoke(route) {
        probes++;
        assert.equal(route.name, "auth.Auth/GetCurrentUser");
        return available;
      },
      async invoke(route) {
        ws++;
        assert.equal(route.name, "auth.Auth/GetCurrentUser");
        return toBinary(
          Auth.method.getCurrentUser.output,
          create(Auth.method.getCurrentUser.output, {
            code: ErrorCode.UNAVAILABLE,
            msg: "WS response",
          }),
        );
      },
    },
  );
  const context: XwapiContext = {
    server,
    session: {
      server,
      sessionId: "session",
      accessToken: "fixture",
      accessExpiresAtMs: BigInt(Date.now() + 60_000),
    },
    signal: new AbortController().signal,
  };
  for (const options of [
    undefined,
    create(XwApiOptionsSchema),
    create(XwApiOptionsSchema, { transport: XwApiTransport.UNSPECIFIED }),
  ]) {
    assert.equal((await service.getCurrentUser({ ...context, options })).msg, "WS response");
  }
  assert.equal(ws, 3);
  assert.equal(http, 0);

  available = false;
  await assert.rejects(
    service.getCurrentUser(context),
    (error: unknown) => error instanceof XwapiError && error.message === "HTTP response",
  );
  assert.equal(http, 1);
  available = true;
  const previousProbes = probes;
  await assert.rejects(
    service.getCurrentUser({
      ...context,
      options: create(XwApiOptionsSchema, { transport: XwApiTransport.HTTP }),
    }),
  );
  for (const call of [
    () => service.login(create(Auth.method.login.input), context),
    () => service.refresh(create(Auth.method.refresh.input, { refreshToken: "test" }), context),
    () => service.checkHealth(context),
    () => service.checkReady(context),
  ]) {
    await assert.rejects(call());
  }
  assert.equal(probes, previousProbes);
  assert.equal(http, 6);
  assert.equal(ws, 3);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(service.getCurrentUser({ ...context, signal: aborted.signal }));
  await assert.rejects(service.getCurrentUser({ ...context, session: undefined }));
  assert.equal(probes, previousProbes);
  assert.equal(http, 6);
  assert.equal(ws, 3);
});

test("default WS failures and malformed responses never replay Logout over HTTP", async () => {
  let http = 0;
  let ws = 0;
  let malformed = false;
  const service = new XwapiService(
    async () => {
      http++;
      throw new Error("HTTP must not replay Logout");
    },
    Date.now,
    {
      canInvoke: () => true,
      async invoke() {
        ws++;
        if (!malformed) throw new Error("connection lost after dispatch");
        return toBinary(Auth.method.logout.output, create(Auth.method.logout.output));
      },
    },
  );
  const context: XwapiContext = {
    server,
    session: {
      server,
      sessionId: "session",
      accessToken: "fixture",
      accessExpiresAtMs: BigInt(Date.now() + 60_000),
    },
    signal: new AbortController().signal,
  };
  for (const invalidResponse of [false, true]) {
    malformed = invalidResponse;
    await assert.rejects(
      service.logout(context),
      (error: unknown) => error instanceof XwapiError && error.code === ErrorCode.UNAVAILABLE,
    );
  }
  assert.equal(ws, 2);
  assert.equal(http, 0);
});
