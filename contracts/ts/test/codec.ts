import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture } from "xiaowei-contracts";

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
