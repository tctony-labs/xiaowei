import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { create, type DescMethodUnary, fromBinary, type MessageShape, toBinary } from "@bufbuild/protobuf";
import { Auth, EmptySchema, ErrorCode, Health, LoginRequestSchema, RefreshRequestSchema } from "xiaowei-contracts";
import { methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi, type RustNapiEndpoint } from "xiaowei-gateway/rust-napi";
import { registerXwapi } from "../../src/main/services/xwapi/gateway";
import { type XwapiContext, XwapiService } from "../../src/main/services/xwapi/service";
import { authServer } from "../main/account-fixture";

const require = createRequire(import.meta.url);
const peer = require("../../../target/rust-napi-tests/search") as {
  createGatewayFixture(): RustNapiEndpoint & {
    fixtureInvoke(route: string, payload: Buffer): Promise<Buffer | string>;
  };
};

test("Rust napi caller reaches all xwapi methods with PB and rejects missing access before HTTP", async () => {
  const server = await authServer();
  const host = new GatewayHost();
  let context: Omit<XwapiContext, "signal"> = { server: server.url };
  const owner = registerXwapi(host, new XwapiService(), () => context);
  const endpoint = peer.createGatewayFixture();
  const remote = await attachRustNapi(host, "xwapi-peer", endpoint);

  async function call<M extends DescMethodUnary>(method: M, request: MessageShape<M["input"]>) {
    const reply = await endpoint.fixtureInvoke(
      JSON.stringify(methodRoute(method)),
      Buffer.from(toBinary(method.input, request)),
    );
    assert.ok(Buffer.isBuffer(reply), String(reply));
    return fromBinary(method.output, reply) as MessageShape<M["output"]>;
  }

  try {
    const empty = create(EmptySchema);
    assert.equal((await call(Auth.method.getCurrentUser, empty)).code, ErrorCode.UNAUTHENTICATED);
    assert.equal((await call(Auth.method.logout, empty)).code, ErrorCode.UNAUTHENTICATED);
    assert.equal(server.state.requests.length, 0);
    assert.equal((await call(Health.method.check, empty)).code, 0);
    server.state.ready = false;
    assert.equal((await call(Health.method.ready, empty)).code, ErrorCode.UNAVAILABLE);
    const login = await call(
      Auth.method.login,
      create(LoginRequestSchema, {
        deviceId: randomUUID(),
        credential: { case: "password", value: { email: "user@example.test", password: "  sample  " } },
      }),
    );
    assert.equal(login.code, 0);
    const count = server.state.requests.length;
    assert.equal((await call(Auth.method.getCurrentUser, empty)).code, ErrorCode.UNAUTHENTICATED);
    assert.equal(server.state.requests.length, count, "raw Login does not commit local credentials");

    const refreshed = await call(
      Auth.method.refresh,
      create(RefreshRequestSchema, { refreshToken: server.state.tokens.refreshToken }),
    );
    assert.equal(refreshed.code, 0);
    assert.ok(server.state.requests.every((request) => request.bearer === undefined));
    // The caller explicitly provides its updated session to the host-side context source.
    context = { server: server.url, session: { server: server.url, ...server.state.tokens } };
    assert.equal((await call(Auth.method.getCurrentUser, empty)).data?.sessionId, server.state.tokens.sessionId);
    assert.equal((await call(Auth.method.logout, empty)).code, 0);
    assert.equal(server.state.requests.at(-1)?.bearer, `Bearer ${server.state.tokens.accessToken}`);
  } finally {
    await remote.close();
    await owner.close();
    await server.close();
  }
});
