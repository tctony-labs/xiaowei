import assert from "node:assert/strict";
import { test } from "node:test";
import { create, getOption, hasOption, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { ApiMethodOptionsSchema, api } from "../src/gen/xiaowei/server/common_pb.ts";
import { Auth, Fixture, Health, serverApiMethod } from "../src/index.ts";

test("server addressing and transport policy come only from method descriptors", () => {
  for (const method of [...Auth.methods, ...Health.methods]) {
    const route = serverApiMethod(method);
    assert.equal(
      route.id,
      `${method.parent.typeName.slice("xiaowei.server.".length)}/${method.name}`,
    );
    assert.equal(route.path, `/api/${route.id}`);
    assert.equal(route.requiresLogin, !getOption(method, api).noLogin);
    assert.equal(route.websocket, route.requiresLogin);
    assert.ok(method.output.typeName.startsWith("xiaowei.server."));
  }
  assert.equal(hasOption(Auth.method.getCurrentUser, api), false);
  assert.equal(hasOption(Auth.method.logout, api), false);
  for (const method of [Auth.method.login, Auth.method.refresh, ...Health.methods]) {
    assert.equal(getOption(method, api).noLogin, true);
    assert.equal(serverApiMethod(method).websocket, false);
  }
  assert.throws(() => serverApiMethod(Fixture.method.echo), /namespace/);
});

test("default requires login; only no_login=true allows unauthenticated HTTP", () => {
  const method = Auth.method.getCurrentUser;
  const withApi = (noLogin?: boolean) => {
    const options = create(MethodOptionsSchema);
    setExtension(options, api, create(ApiMethodOptionsSchema, { noLogin }));
    return options;
  };
  for (const options of [undefined, create(MethodOptionsSchema), withApi(), withApi(false)]) {
    const descriptor = { ...method, proto: { ...method.proto, options } };
    assert.equal(serverApiMethod(descriptor).requiresLogin, true);
    assert.equal(serverApiMethod(descriptor).websocket, true);
  }
  const descriptor = { ...method, proto: { ...method.proto, options: withApi(true) } };
  assert.equal(serverApiMethod(descriptor).requiresLogin, false);
  assert.equal(serverApiMethod(descriptor).websocket, false);
});
