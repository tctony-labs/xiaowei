import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { create, fromBinary, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, LoginRequestSchema, LoginResponseSchema } from "xiaowei-contracts";

const [rust, go] = process.argv.slice(2);
assert.equal(Fixture.typeName, "testing.Fixture");
assert.equal(Fixture.method.echo.methodKind, "unary");
assert.equal(Fixture.method.echo.input.typeName, EnvelopeSchema.typeName);
assert.equal(Fixture.method.echo.output.typeName, EnvelopeSchema.typeName);
assert.equal(Fixture.method.watch.methodKind, "server_streaming");
assert.equal(Fixture.method.watch.input.typeName, EnvelopeSchema.typeName);
assert.equal(Fixture.method.watch.output.typeName, ChangedSchema.typeName);
assert.equal(ChangedSchema.typeName, "testing.Changed");
assert.deepEqual(
  EnvelopeSchema.fields.map((f) => f.number),
  [1, 2, 3, 4, 5, 6],
);
const transcode = (bin: string, input: Uint8Array) =>
  new Uint8Array(execFileSync(bin, [], { input, maxBuffer: 8 * 1024 * 1024 }));
const cases = [
  create(EnvelopeSchema),
  create(EnvelopeSchema, { id: 9007199254740993n, value: { case: "stringValue", value: "增量" } }),
  create(EnvelopeSchema, { label: "", value: { case: "nullValue", value: 0 } }),
  create(EnvelopeSchema, {
    text: "你好 🌍 café",
    id: 18446744073709551615n,
    label: "present",
    value: { case: "stringValue", value: "" },
    blobs: [{ data: new Uint8Array([0, 255, 128]) }, { data: new Uint8Array(2 * 1024 * 1024).fill(197) }],
  }),
];
for (const value of cases) {
  const bytes = toBinary(EnvelopeSchema, value);
  for (const path of [[rust], [go], [rust, go], [go, rust]]) {
    const result = path.reduce((data, bin) => transcode(bin, data), bytes);
    assert.deepEqual(fromBinary(EnvelopeSchema, result), value);
  }
}
// A compatible field addition (field 100, varint 7) is accepted by all decoders.
const added = new Uint8Array([0xa0, 0x06, 0x07]);
assert.deepEqual(toBinary(EnvelopeSchema, fromBinary(EnvelopeSchema, added)), added);
assert.deepEqual(transcode(go, added), added);
assert.deepEqual(transcode(rust, added), new Uint8Array()); // prost drops unknown fields.
for (const invalid of [new Uint8Array([0x0a, 0x05, 0x01]), new Uint8Array([0x80])]) {
  assert.throws(() => fromBinary(EnvelopeSchema, invalid));
  for (const bin of [rust, go]) assert.notEqual(spawnSync(bin, [], { input: invalid }).status, 0);
}
console.log(
  "Codec checks passed: TS/Rust/Go, both traversal orders, descriptors, presence, null, bytes, uint64, unknown and invalid wire.",
);

// Exercise the actual login contract through both generated native consumers.
for (const token of [undefined, "", "bind-proof"]) {
  const request = create(LoginRequestSchema, {
    deviceId: "550e8400-e29b-41d4-a716-446655440000",
    thirdpartyBindToken: token,
    credential: { case: "password", value: { email: "a@example.com", password: "secret" } },
  });
  for (const order of [
    [rust, go],
    [go, rust],
  ]) {
    const bytes = order.reduce(
      (data, bin) => new Uint8Array(execFileSync(bin, ["login-request"], { input: data })),
      toBinary(LoginRequestSchema, request),
    );
    assert.deepEqual(fromBinary(LoginRequestSchema, bytes), request);
  }
}
const loginResponses: JsonValue[] = [
  { code: 0, msg: "ok", data: { authenticated: { device: { device_id: "device" } } } },
  {
    code: 0,
    msg: "ok",
    data: {
      binding_required: {
        thirdparty_bind_token: "proof",
        expires_at_ms: "1791100000000",
      },
    },
  },
  { code: 10100, msg: "invalid credentials" },
  { code: 0, msg: "ok", data: {} },
];
for (const json of loginResponses) {
  const response = fromJson(LoginResponseSchema, json);
  for (const order of [
    [rust, go],
    [go, rust],
  ]) {
    const bytes = order.reduce(
      (data, bin) => new Uint8Array(execFileSync(bin, ["login-response"], { input: data })),
      toBinary(LoginResponseSchema, response),
    );
    assert.deepEqual(fromBinary(LoginResponseSchema, bytes), response);
  }
}
const binding = fromJson(LoginResponseSchema, {
  code: 0,
  msg: "ok",
  data: { binding_required: { thirdparty_bind_token: "proof", expires_at_ms: "123" } },
});
assert.equal(binding.data?.result.case, "bindingRequired");
if (binding.data?.result.case === "bindingRequired") {
  assert.equal(binding.data.result.value.expiresAtMs, 123n);
}
assert.throws(() =>
  fromJson(LoginResponseSchema, {
    code: 0,
    data: { authenticated: {}, binding_required: {} },
  }),
);
console.log("Login codec checks passed: oneof results, password credentials, optional binding token and JSON.");
