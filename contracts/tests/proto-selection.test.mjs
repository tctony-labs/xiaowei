import assert from "node:assert/strict";
import test from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { selectProtoFiles, targetLayout } from "../scripts/proto-selection.mjs";

const local = [
  "example/types/id.proto",
  "example/types/message.proto",
  "example/desktop/local.proto",
  "example/server/api.proto",
];
const definitions = [
  { name: local[0], package: "example.types" },
  {
    name: local[1],
    package: "example.types",
    dependency: [local[0], "google/protobuf/empty.proto"],
    publicDependency: [0],
  },
  { name: local[2], package: "example.desktop" },
  { name: local[3], package: "example.server", dependency: [local[1]] },
  { name: "google/protobuf/empty.proto", package: "google.protobuf" },
];
const descriptor = (files = definitions) =>
  toBinary(FileDescriptorSetSchema, create(FileDescriptorSetSchema, { file: files }));
const network = ["proto-network-rs", "proto-desktop-ts", "proto-server-go"];
const config = {
  sources: {
    "example/types/**": [...network],
    "example/server/**": [...network],
    "example/desktop/**": ["proto-desktop-rs", "proto-desktop-ts"],
  },
};

test("target names determine the language and fixed generation directory", () => {
  for (const [name, language, directory] of [
    ["proto-network-rs", "rust", "src/gen"],
    ["proto-desktop-ts", "ts", "src/gen"],
    ["proto-server-go", "go", "gen"],
  ]) {
    assert.deepEqual(targetLayout(name), {
      language,
      output: `contracts/out/${name}`,
      generated: `contracts/out/${name}/${directory}`,
    });
  }
  for (const invalid of ["network-rs", "proto-network-java", "proto-../api-rs", "proto-api-rs/"]) {
    assert.throws(() => targetLayout(invalid), /Invalid proto target/);
  }
});

test("directory rules select whole packages for multiple language outputs", () => {
  const targets = selectProtoFiles(descriptor(), config, local);
  assert.deepEqual(targets["proto-desktop-ts"].files, [...local].sort());
  assert.deepEqual(targets["proto-desktop-rs"].files, [local[2]]);
  for (const name of ["proto-network-rs", "proto-server-go"]) {
    assert.deepEqual(targets[name].files, [local[0], local[1], local[3]].sort());
  }
  assert.ok(Object.values(targets).every((target) => !target.files.includes(definitions[4].name)));
});

test("recursive directory rules include nested files; a single star covers one level", () => {
  const name = "example/desktop/nested/file.proto";
  const files = [...definitions, { name, package: "example.nested" }];
  const targets = selectProtoFiles(descriptor(files), config, [...local, name]);
  assert.ok(targets["proto-desktop-rs"].files.includes(name));

  const shallow = structuredClone(config);
  shallow.sources["example/desktop/*"] = shallow.sources["example/desktop/**"];
  delete shallow.sources["example/desktop/**"];
  assert.throws(
    () => selectProtoFiles(descriptor(files), shallow, [...local, name]),
    /Missing output mapping/,
  );
});

test("an exact file rule overrides its directory without depending on rule order", () => {
  for (const sources of [
    { ...config.sources, [local[2]]: ["proto-desktop-ts"] },
    { [local[2]]: ["proto-desktop-ts"], ...config.sources },
  ]) {
    const targets = selectProtoFiles(descriptor(), { sources }, local);
    assert.equal(targets["proto-desktop-rs"], undefined);
    assert.ok(targets["proto-desktop-ts"].files.includes(local[2]));
  }
});

test("conflicting glob rules and different outputs within one package are rejected", () => {
  const conflicting = structuredClone(config);
  conflicting.sources["example/**"] = ["proto-other-rs"];
  assert.throws(
    () => selectProtoFiles(descriptor(), conflicting, local),
    /Conflicting source patterns/,
  );

  const split = structuredClone(config);
  split.sources[local[0]] = ["proto-desktop-ts"];
  assert.throws(() => selectProtoFiles(descriptor(), split, local), /Inconsistent outputs/);
});

test("business imports must remain in the same output as their consumer", () => {
  const invalid = structuredClone(config);
  invalid.sources["example/server/**"][0] = "proto-separate-rs";
  assert.throws(
    () => selectProtoFiles(descriptor(), invalid, local),
    /Cross-target proto import.*proto-separate-rs/,
  );
});

test("invalid, unmatched or incomplete rules cannot silently delete generated outputs", () => {
  const cases = [null, {}, { ...config, targets: {} }, { sources: [] }];
  for (const names of [
    [],
    "proto-desktop-ts",
    [null],
    ["bad"],
    ["proto-desktop-ts", "proto-desktop-ts"],
  ]) {
    cases.push({ sources: { ...config.sources, "example/types/**": names } });
  }
  for (const pattern of ["missing/**", "../escape/**", "/absolute/**", "example\\types\\*"]) {
    cases.push({ sources: { ...config.sources, [pattern]: ["proto-desktop-ts"] } });
  }
  const missing = structuredClone(config);
  delete missing.sources["example/desktop/**"];
  cases.push(missing);
  for (const invalid of cases) {
    assert.throws(() => selectProtoFiles(descriptor(), invalid, local));
  }
});

test("each package has only one type provider per language", () => {
  for (const suffix of ["rs", "ts", "go"]) {
    const invalid = structuredClone(config);
    invalid.sources["example/types/**"].push(`proto-duplicate-${suffix}`);
    assert.throws(
      () => selectProtoFiles(descriptor(), invalid, local),
      /Multiple .* type providers/,
    );
  }
});

test("missing descriptors, packages and unresolved imports fail explicitly", () => {
  assert.throws(() => selectProtoFiles(descriptor(), config, [...local, "missing.proto"]));
  const noPackage = structuredClone(definitions);
  noPackage[0].package = "";
  assert.throws(() => selectProtoFiles(descriptor(noPackage), config, local));
  const missingImport = structuredClone(definitions);
  missingImport[0].dependency = ["missing.proto"];
  assert.throws(
    () => selectProtoFiles(descriptor(missingImport), config, local),
    /Missing local proto/,
  );
});
