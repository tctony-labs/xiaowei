import assert from "node:assert/strict";
import test from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { selectProtoFiles } from "../proto-selection.mjs";

const local = [
  "example/common/id.proto",
  "example/common/message.proto",
  "example/desktop/local.proto",
  "example/server/api.proto",
];
const descriptor = toBinary(
  FileDescriptorSetSchema,
  create(FileDescriptorSetSchema, {
    file: [
      { name: local[0] },
      { name: local[1], dependency: [local[0], "google/protobuf/timestamp.proto"], publicDependency: [0] },
      { name: local[2] },
      { name: local[3], dependency: [local[1]] },
      { name: "google/protobuf/timestamp.proto" },
    ],
  }),
);
const config = { ts: ["example/**/*.proto"], rust: ["example/**/*.proto"], go: ["example/server/*.proto"] };

test("language entries include transitive local imports but exclude unrelated and well-known files", () => {
  assert.deepEqual(selectProtoFiles(descriptor, config, local), {
    ts: local,
    rust: local,
    go: [local[0], local[1], local[3]],
  });
});
test("overlapping entries deduplicate and empty language lists disable generation", () => {
  assert.deepEqual(selectProtoFiles(descriptor, { ts: [], rust: [], go: [local[3], local[1]] }, local), {
    ts: [],
    rust: [],
    go: [local[0], local[1], local[3]],
  });
});
test("invalid or unmatched configuration fails instead of silently deleting outputs", () => {
  for (const invalid of [
    { ...config, go: ["missing.proto"] },
    { ...config, go: "*.proto" },
    { ts: [], rust: [] },
    { ...config, typo: [] },
  ]) {
    assert.throws(() => selectProtoFiles(descriptor, invalid, local));
  }
});
