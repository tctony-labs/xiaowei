import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-contracts-check-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  };
  const read = (path) => readFileSync(join(directory, path), "utf8");
  const run = (check = true) =>
    spawnSync(
      process.execPath,
      [join(directory, "contracts/scripts/generate.mjs"), ...(check ? ["--check"] : [])],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
  const success = (cached) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes("(cached;"), cached, result.stdout);
    return result;
  };

  for (const path of [
    "contracts/scripts",
    "contracts/tools",
    "contracts/ts/proto-selection.mjs",
    "contracts/ts/package.json",
    "contracts/go/go.mod",
    "contracts/go/go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".node-version",
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  write(
    "contracts/proto/example.proto",
    'syntax = "proto3";\npackage example;\nmessage Value { string text = 1; }\n',
  );
  write(
    "contracts/generate.config.json",
    JSON.stringify({ ts: ["*.proto"], rust: [], go: ["*.proto"] }),
  );
  // The real TS and Go generators exercise caching without rebuilding Rust in each fixture.
  symlinkSync(
    join(root, "contracts/ts/node_modules"),
    join(directory, "contracts/ts/node_modules"),
    "dir",
  );
  const generated = run(false);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(existsSync(join(directory, "target/contracts-check.sha256")), false);
  return { directory, write, read, run, success };
}

test("only a successful check is cached; timestamps and unrelated files do not invalidate it", (context) => {
  const { directory, write, run, success } = fixture(context);
  success(false);
  success(true);
  const future = Date.now() / 1000 + 1000;
  utimesSync(join(directory, "contracts/proto/example.proto"), future, future);
  write("contracts/proto/README.md", "Unrelated documentation\n");
  write("desktop/example.ts", "Unrelated implementation\n");
  success(true);

  const generated = run(false);
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /Contracts generated/);
  assert.doesNotMatch(generated.stdout, /cached/);

  write("target/contracts-check.sha256", "incomplete cache");
  success(false);
  success(true);
  rmSync(join(directory, "target/contracts-check.sha256"));
  success(false);
});

test("generator, configuration and dependency changes invalidate a successful cache", (context) => {
  const { write, read, success } = fixture(context);
  success(false);
  for (const path of [
    "contracts/scripts/generate.mjs",
    "contracts/scripts/ensure-protoc.mjs",
    "contracts/ts/proto-selection.mjs",
    "contracts/tools/src/main.rs",
    "contracts/tools/Cargo.toml",
    "contracts/generate.config.json",
    "contracts/ts/package.json",
    "contracts/go/go.mod",
    "contracts/go/go.sum",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
  ]) {
    write(path, `${read(path)}\n`);
    success(false);
    success(true);
  }
});

test("changed, added and deleted proto files cannot reuse the cache, and failures are not cached", (context) => {
  const { directory, write, read, run, success } = fixture(context);
  success(false);
  const original = read("contracts/proto/example.proto");
  const cached = read("target/contracts-check.sha256");
  const fail = () => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /cached/);
    assert.equal(read("target/contracts-check.sha256"), cached);
  };

  write("contracts/proto/example.proto", original.replace("string text", "bytes text"));
  fail();
  fail();
  write("contracts/proto/example.proto", original);
  success(true);

  write("contracts/proto/added.proto", 'syntax = "proto3";\nmessage Added {}\n');
  fail();
  rmSync(join(directory, "contracts/proto/added.proto"));
  rmSync(join(directory, "contracts/proto/example.proto"));
  fail();
});

test("edited, missing and extra generated outputs force drift checks even with unchanged proto", (context) => {
  const { directory, write, read, run, success } = fixture(context);
  success(false);
  const cached = read("target/contracts-check.sha256");
  const fail = () => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Stale contracts/);
    assert.equal(read("target/contracts-check.sha256"), cached);
  };
  for (const path of ["contracts/ts/src/gen/example_pb.ts", "contracts/go/gen/example.pb.go"]) {
    const original = read(path);
    write(path, `${original}\n// edited\n`);
    fail();
    rmSync(join(directory, path));
    fail();
    write(path, original);
    success(true);
  }
  for (const path of [
    "contracts/ts/src/gen/extra.ts",
    "contracts/rust/src/gen/extra.rs",
    "contracts/go/gen/extra.go",
  ]) {
    write(path, "// extra\n");
    fail();
    rmSync(join(directory, path));
    success(true);
  }
});
