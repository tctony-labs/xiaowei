import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ErrorCode, LoginRequestSchema } from "proto-desktop-ts";
import { XwAccount } from "xiaowei-rust";
import { authServer } from "./account-fixture";

const access = { login: true, refresh: true, currentUser: true, logout: true };

function loginRequest() {
  return Buffer.from(
    toBinary(
      LoginRequestSchema,
      create(LoginRequestSchema, {
        deviceId: randomUUID(),
        credential: {
          case: "password",
          value: { email: "user@example.test", password: "  sample  " },
        },
      }),
    ),
  );
}

test("fixed native login checks original Auth permission before making a request", async (t) => {
  const server = await authServer();
  const native = new XwAccount();
  const endpoint = native.createGatewayEndpoint();
  t.after(async () => {
    await endpoint.close();
    await server.close();
  });
  const context = {
    operationId: randomUUID(),
    server: server.url,
    connect: false,
    nowMs: server.state.now,
  };
  const result = await native.login(context, loginRequest(), { ...access, login: false });
  assert.equal(result.code, ErrorCode.PERMISSION_DENIED);
  assert.equal(result.authenticated, undefined);
  assert.equal(typeof result.credentialVersion, "bigint");
  assert.equal(server.state.requests.length, 0);
  native.releaseOperation(context.operationId);
  await assert.rejects(
    async () => native.readResult(context.operationId, context.nowMs),
    /not found/,
  );
});

test("immediate native cancellation prevents a pending login from committing credentials", async (t) => {
  const server = await authServer();
  const native = new XwAccount();
  const endpoint = native.createGatewayEndpoint();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.state.beforeLogin = () => blocked;
  t.after(async () => {
    release();
    await endpoint.close();
    await server.close();
  });
  const context = {
    operationId: randomUUID(),
    server: server.url,
    connect: false,
    nowMs: server.state.now,
  };
  const pending = native.login(context, loginRequest(), access);
  native.cancelOperation(context.operationId);
  const result = await pending;
  assert.equal(result.code, ErrorCode.UNAVAILABLE);
  assert.equal(result.checkpoint, false);
  assert.equal(result.authenticated, undefined);
  const retained = await native.readResult(context.operationId, context.nowMs);
  assert.equal(retained.authenticated, undefined);
  assert.equal(retained.checkpoint, false);
  native.releaseOperation(context.operationId);
  native.releaseOperation(context.operationId);
});

test("fixed native restore can start the authenticated connection on its own", async (t) => {
  const server = await authServer();
  await server.enableWebsocket();
  const native = new XwAccount();
  const endpoint = native.createGatewayEndpoint();
  t.after(async () => {
    await endpoint.close();
    await server.close();
  });
  const context = {
    operationId: randomUUID(),
    server: server.url,
    connect: false,
    nowMs: server.state.now,
  };
  const login = await native.login(context, loginRequest(), access);
  assert.equal(login.code, 0);
  assert.ok(login.authenticated);
  native.releaseOperation(context.operationId);
  const restore = {
    ...context,
    operationId: randomUUID(),
    authenticated: login.authenticated,
    connect: true,
  };
  const result = await native.restore(restore, false, access);
  assert.equal(result.code, 0);
  assert.equal(result.checkpoint, false);
  assert.ok(result.authenticated);
  assert.equal(server.state.requests.at(-1)?.transport, "websocket");
  native.releaseOperation(restore.operationId);
});
