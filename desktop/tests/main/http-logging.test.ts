import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ErrorCode, LogoutResponseSchema } from "xiaowei-contracts";
import { HttpRequestError, ServerHttpClient } from "../../src/main/services/xwapi/http";
import { XwapiError, XwapiService } from "../../src/main/services/xwapi/service";

const secrets = ["secret-password", "secret-access", "secret-refresh", "private@example.com", "secret-message"];
const success = JSON.stringify({ code: 0, msg: secrets[4], data: {} });

test("shared HTTP logging uses metadata for arbitrary routes and keeps secrets out at every level", async (t) => {
  const cases = [
    { name: "success", body: success, level: "debug", outcome: "success", code: 0 },
    {
      name: "rejected",
      body: JSON.stringify({ code: 10100, msg: secrets[4] }),
      level: "warn",
      outcome: "business_error",
      code: 10100,
    },
    {
      name: "unavailable",
      body: JSON.stringify({ code: ErrorCode.UNAVAILABLE, msg: secrets[4] }),
      level: "error",
      outcome: "business_error",
      code: ErrorCode.UNAVAILABLE,
    },
    {
      name: "internal",
      body: JSON.stringify({ code: ErrorCode.INTERNAL_ERROR, msg: secrets[4] }),
      level: "error",
      outcome: "business_error",
      code: ErrorCode.INTERNAL_ERROR,
    },
    { name: "http400", body: secrets.join(" "), status: 400, level: "warn", outcome: "http_error" },
    { name: "http500", body: secrets.join(" "), status: 500, level: "error", outcome: "http_error" },
    { name: "json", body: secrets.join(" "), level: "error", outcome: "protocol_error" },
    { name: "null", body: "null", level: "error", outcome: "protocol_error" },
    { name: "envelope", body: JSON.stringify({ foo: secrets }), level: "error", outcome: "protocol_error" },
    {
      name: "missing data",
      body: JSON.stringify({ code: 0, msg: secrets[4] }),
      level: "error",
      outcome: "protocol_error",
      code: 0,
    },
    {
      name: "proto",
      body: JSON.stringify({ code: 0, msg: secrets[4], data: { foo: secrets } }),
      level: "error",
      outcome: "protocol_error",
      code: 0,
    },
    { name: "large", body: success + " ".repeat(65_537), level: "error", outcome: "response_too_large" },
    { name: "network", network: true, level: "error", outcome: "network_error" },
    { name: "cancelled", cancelled: true, level: "debug", outcome: "cancelled" },
  ];
  for (const tc of cases) {
    await t.test(tc.name, async (t) => {
      const calls: { level: string; args: unknown[] }[] = [];
      for (const level of ["debug", "info", "warn", "error"] as const) {
        t.mock.method(console, level, (...args: unknown[]) => calls.push({ level, args }));
      }
      const caller = new AbortController();
      if (tc.cancelled) caller.abort(new Error(secrets.join(" ")));
      const client = new ServerHttpClient(async (_url, options) => {
        assert.equal(calls.length, 1);
        assert.equal(calls[0].level, "debug");
        assert.ok(String(calls[0].args[0]).startsWith("HTTP request started "));
        assert.equal(options?.redirect, "error");
        assert.equal(options?.method, "POST");
        assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${secrets[1]}`);
        if (tc.cancelled) options?.signal?.throwIfAborted();
        if (tc.network) throw new Error(secrets.join(" "), { cause: secrets });
        return new Response(tc.body, { status: tc.status ?? 200, headers: { "Set-Cookie": secrets[2] } });
      });
      const request = client.request(
        "https://secret-user:secret-url-password@example.test:10001/secret-base/" +
          "secret-path?foo=secret-query#secret-fragment",
        LogoutResponseSchema,
        {
          method: "POST",
          logPath: "/api/another/:id",
          signal: caller.signal,
          body: JSON.stringify({ foo: secrets }),
          token: secrets[1],
        },
      );
      if (tc.outcome === "success") {
        assert.equal((await request).code, 0);
      } else {
        await assert.rejects(request, (error: unknown) => {
          assert.ok(error instanceof HttpRequestError);
          assert.equal(error.outcome, tc.outcome);
          if (tc.outcome === "business_error") assert.equal(error.message, secrets[4]);
          return true;
        });
      }
      assert.equal(calls.length, 2);
      assert.equal(calls[1].level, tc.level);
      assert.ok(String(calls[1].args[0]).startsWith("HTTP request completed "));
      const started = logFields(calls[0].args);
      assert.deepEqual(started, { method: "POST", path: "/api/another/:id", server: "https://example.test:10001" });
      const metadata = logFields(calls[1].args);
      assert.ok(!Object.hasOwn(metadata, "outcome"));
      assert.equal(metadata.path, "/api/another/:id");
      assert.equal(metadata.server, "https://example.test:10001");
      assert.equal(typeof metadata.duration_ms, "number");
      assert.ok(Number(metadata.duration_ms) >= 0);
      assert.equal(metadata.code, tc.code);
      assert.equal(metadata.http_status, tc.network || tc.cancelled ? undefined : (tc.status ?? 200));
      if (tc.code === undefined) assert.ok(!Object.hasOwn(metadata, "code"));
      const serialized = JSON.stringify(calls);
      for (const secret of [
        ...secrets,
        "secret-user",
        "secret-url-password",
        "secret-base",
        "secret-path",
        "secret-query",
        "secret-fragment",
      ]) {
        assert.ok(!serialized.includes(secret), "request metadata exposed private content");
      }
    });
  }
});

test("a real stalled HTTP request times out with one safe error log", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "debug", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const server = createServer(() => {
    assert.equal(logs.length, 1);
    assert.ok(String(logs[0][0]).startsWith("HTTP request started "));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(
    new ServerHttpClient().request(`http://127.0.0.1:${address.port}/never`, LogoutResponseSchema, {
      method: "GET",
      logPath: "/api/never",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof HttpRequestError && error.outcome === "timeout",
  );
  assert.equal(logs.length, 2);
  assert.ok(String(logs[1][0]).startsWith("HTTP request completed "));
  const metadata = logFields(logs[1]);
  assert.ok(!Object.hasOwn(metadata, "outcome"));
  assert.ok(Number(metadata.duration_ms) >= 9_900 && Number(metadata.duration_ms) < 15_000);
  assert.ok(!Object.hasOwn(metadata, "code") && !Object.hasOwn(metadata, "http_status"));
});

test("authentication wrappers preserve business messages and transport error mapping", async (t) => {
  t.mock.method(console, "debug", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const cases = [
    { response: '{"code":10100,"msg":"邮箱或密码错误"}', code: 10100, msg: "邮箱或密码错误" },
    { response: "null", code: ErrorCode.UNAVAILABLE, msg: "服务器返回了无效的响应" },
    { response: " ".repeat(65_537), code: ErrorCode.UNAVAILABLE, msg: "无法连接服务器，请稍后重试" },
    { response: "", status: 502, code: ErrorCode.UNAVAILABLE, msg: "无法连接服务器，请稍后重试" },
  ];
  for (const tc of cases) {
    const client = new XwapiService(async () => new Response(tc.response, { status: tc.status ?? 200 }));
    await assert.rejects(
      client.getCurrentUser({
        server: "https://example.test",
        signal: new AbortController().signal,
        session: {
          server: "https://example.test",
          sessionId: "session",
          accessToken: secrets[1],
          accessExpiresAtMs: 2n ** 60n,
        },
      }),
      (error: unknown) => error instanceof XwapiError && error.code === tc.code && error.message === tc.msg,
    );
  }
});

function logFields(args: unknown[]): Record<string, string | number> {
  assert.equal(args.length, 1);
  const text = args[0];
  assert.equal(typeof text, "string");
  assert.ok(!/[\r\n{}]/u.test(text as string), "HTTP logs must be single-line key=value text");
  const fields: Record<string, string | number> = {};
  for (const match of (text as string).matchAll(/([a-z_]+)=("(?:\\.|[^"])*"|\S+)/gu)) {
    const value = match[2];
    fields[match[1]] = value.startsWith('"') ? JSON.parse(value) : /^\d+$/u.test(value) ? Number(value) : value;
  }
  return fields;
}
