import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { Health } from "proto-desktop-ts";
import { bindClient, GatewayFailure } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { initializeLogging, type NativeLogEntry } from "xiaowei-rust";
import { authServer } from "./account-fixture";
import { attachServerApiFixture } from "./server-api-fixture";

const secrets = ["secret-password", "secret-access", "secret-refresh", "private@example.com"];
const responseMessage = "服务器返回的提示";

test("real native HTTP logs retain severity, metadata and omit private content", async (t) => {
  const entries: NativeLogEntry[] = [];
  initializeLogging(true, (entry) => {
    if (entry.target === "xw_api::http") entries.push(entry);
  });
  const server = await authServer();
  const host = new GatewayHost();
  const owner = await attachServerApiFixture(host, () => ({ server: server.url }));
  const health = bindClient(Health, host.client({ caller: "logging", trusted: true }));
  t.after(async () => {
    await owner.close();
    await server.close();
  });
  for (const item of [
    { name: "success", body: { code: 0, msg: responseMessage, data: {} }, level: "debug", code: 0 },
    { name: "business", body: { code: 10100, msg: responseMessage }, level: "warn", code: 10100 },
    {
      name: "unavailable",
      body: { code: 10008, msg: responseMessage },
      level: "error",
      code: 10008,
    },
    { name: "internal", body: { code: 10009, msg: responseMessage }, level: "error", code: 10009 },
    { name: "http400", body: secrets, status: 400, level: "warn", code: 10008 },
    { name: "http500", body: secrets, status: 500, level: "error", code: 10008 },
    { name: "json", body: "invalid JSON", level: "error", code: 10008 },
    { name: "null", body: "null", level: "error", code: 10008 },
    { name: "envelope", body: { foo: secrets }, level: "error", code: 10008 },
    { name: "missing data", body: { code: 0, msg: responseMessage }, level: "error", code: 10008 },
    {
      name: "proto",
      body: { code: 0, msg: responseMessage, data: { foo: secrets } },
      level: "error",
      code: 10008,
    },
    { name: "large", body: " ".repeat(65537), level: "error", code: 10008 },
  ]) {
    await t.test(item.name, async () => {
      entries.length = 0;
      server.state.healthStatus = item.status ?? 200;
      server.state.healthResponse =
        typeof item.body === "string" ? item.body : JSON.stringify(item.body);
      assert.equal((await health.check(create(EmptySchema))).code, item.code);
      const deadline = Date.now() + 1000;
      while (entries.length < 2 && Date.now() < deadline) await delay(1);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].level, "debug");
      assert.ok(entries[0].message.startsWith("HTTP request started "));
      assert.ok(entries[0].message.includes("timeout_ms=15000"));
      assert.equal(entries[1].level, item.level);
      assert.ok(entries[1].message.includes("path=/api/Health/Check"));
      assert.ok(entries[1].message.includes(`http_status=${item.status ?? 200}`));
      assert.match(entries[1].message, /duration_ms=\d+/u);
      if (typeof item.body === "object" && "msg" in item.body) {
        assert.ok(entries[1].message.includes(`code=${item.body.code}`));
        assert.ok(entries[1].message.includes(`msg=${JSON.stringify(responseMessage)}`));
      }
      for (const secret of secrets) assert.ok(!JSON.stringify(entries).includes(secret));
      assert.ok(!JSON.stringify(entries).includes("/xiaowei"), "never log the user-supplied path");
    });
  }
  entries.length = 0;
  server.state.offline = true;
  assert.equal((await health.check(create(EmptySchema))).code, 10008);
  const failedDeadline = Date.now() + 1000;
  while (entries.length < 2 && Date.now() < failedDeadline) await delay(1);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, "error");
  assert.ok(entries[1].message.includes("error_code=10008"));
  assert.ok(entries[1].message.includes("error_msg="));
  assert.ok(entries[1].message.includes("error="));
  assert.ok(!entries[1].message.includes("/xiaowei"));
  server.state.offline = false;

  entries.length = 0;
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  server.state.beforeHealth = () => {
    arrived();
    return new Promise(() => {});
  };
  const request = health.check(create(EmptySchema));
  const cancelled = assert.rejects(
    request,
    (error: unknown) => error instanceof GatewayFailure && error.detail.code === "CANCELLED",
  );
  await started;
  request.cancel();
  await cancelled;
  const deadline = Date.now() + 1000;
  while (entries.length < 2 && Date.now() < deadline) await delay(1);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, "debug");
  assert.match(entries[1].message, /duration_ms=\d+/u);
});
