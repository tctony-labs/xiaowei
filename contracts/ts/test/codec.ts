import assert from "node:assert/strict";
import { create, fromBinary, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, LoginRequestSchema, LoginResponseSchema } from "xiaowei-contracts";
import { runCodec } from "./codec-process.ts";

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
const cases = [
  { name: "empty envelope", value: create(EnvelopeSchema) },
  {
    name: "uint64 above JS precision",
    value: create(EnvelopeSchema, { id: 9007199254740993n, value: { case: "stringValue", value: "增量" } }),
  },
  {
    name: "optional empty label and null",
    value: create(EnvelopeSchema, { label: "", value: { case: "nullValue", value: 0 } }),
  },
  {
    name: "unicode, max uint64 and 2 MiB blob",
    value: create(EnvelopeSchema, {
      text: "你好 🌍 café",
      id: 18446744073709551615n,
      label: "present",
      value: { case: "stringValue", value: "" },
      blobs: [{ data: new Uint8Array([0, 255, 128]) }, { data: new Uint8Array(2 * 1024 * 1024).fill(197) }],
    }),
  },
];
const routeName = (path: string[]) => path.map((bin) => (bin === rust ? "Rust" : "Go")).join(" -> ");

for (const { name, value } of cases) {
  const bytes = toBinary(EnvelopeSchema, value);
  for (const path of [[rust], [go], [rust, go], [go, rust]]) {
    const caseName = `${name}, ${routeName(path)}`;
    const result = path.reduce((data, bin) => runCodec(bin, data, { caseName }), bytes);
    assert.deepEqual(fromBinary(EnvelopeSchema, result), value);
  }
}
// A compatible field addition (field 100, varint 7) is accepted by all decoders.
const added = new Uint8Array([0xa0, 0x06, 0x07]);
assert.deepEqual(toBinary(EnvelopeSchema, fromBinary(EnvelopeSchema, added)), added);
assert.deepEqual(runCodec(go, added, { caseName: "unknown field preserved" }), added);
assert.deepEqual(runCodec(rust, added, { caseName: "unknown field dropped" }), new Uint8Array());
for (const [name, invalid] of [
  ["truncated length-delimited field", new Uint8Array([0x0a, 0x05, 0x01])],
  ["truncated varint", new Uint8Array([0x80])],
] as const) {
  assert.throws(() => fromBinary(EnvelopeSchema, invalid));
  for (const bin of [rust, go]) {
    runCodec(bin, invalid, { caseName: name, expectFailure: true });
  }
}
console.log(
  "Codec checks passed: TS/Rust/Go, both traversal orders, descriptors, presence, null, bytes, uint64, " +
    "unknown and invalid wire.",
);

// Exercise the actual login contract through both generated native consumers.
for (const [name, token] of [
  ["absent binding token", undefined],
  ["empty binding token", ""],
  ["present binding token", "bind-proof"],
] as const) {
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
      (data, bin) => runCodec(bin, data, { args: ["login-request"], caseName: `${name}, ${routeName(order)}` }),
      toBinary(LoginRequestSchema, request),
    );
    assert.deepEqual(fromBinary(LoginRequestSchema, bytes), request);
  }
}
const loginResponses: { name: string; json: JsonValue }[] = [
  {
    name: "authenticated",
    json: { code: 0, msg: "ok", data: { authenticated: { device: { device_id: "device" } } } },
  },
  {
    name: "binding required",
    json: {
      code: 0,
      msg: "ok",
      data: {
        binding_required: {
          thirdparty_bind_token: "proof",
          expires_at_ms: "1791100000000",
        },
      },
    },
  },
  { name: "invalid credentials", json: { code: 10100, msg: "invalid credentials" } },
  { name: "empty result", json: { code: 0, msg: "ok", data: {} } },
];
for (const { name, json } of loginResponses) {
  const response = fromJson(LoginResponseSchema, json);
  for (const order of [
    [rust, go],
    [go, rust],
  ]) {
    const bytes = order.reduce(
      (data, bin) =>
        runCodec(bin, data, {
          args: ["login-response"],
          caseName: `${name}, ${routeName(order)}`,
        }),
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
