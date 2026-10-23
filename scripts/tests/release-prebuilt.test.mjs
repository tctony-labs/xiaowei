import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeHashes, testPrebuilt } from "../release/test-prebuilt.mjs";

test("release tests set prepared only after fixture preparation and never build production addons", async () => {
  const calls = [];
  await testPrebuilt({
    hashes: () => ["unchanged"],
    run(args, env) {
      calls.push(args);
      if (args.includes("test")) assert.equal(env.XIAOWEI_TEST_NAPI_PREPARED, "1");
    },
    async fixtures(packages, tests, options) {
      assert.deepEqual(packages, ["rust", "agent"]);
      assert.deepEqual(options, { prepared: false, productionPrepared: true });
      calls.push("fixture prepared");
      await tests();
    },
  });
  assert.deepEqual(calls, [
    ["check"],
    [
      "exec",
      "node",
      "--test",
      "scripts/dev/build-napi.test.mjs",
      "scripts/dev/desktop-source-resolution.test.mjs",
      "scripts/tests/package-content.test.mjs",
      "scripts/tests/macos-release.test.mjs",
      "scripts/tests/sparkle-delta.test.mjs",
      "scripts/tests/release-prebuilt.test.mjs",
      "scripts/tests/debug-symbols.test.mjs",
      "scripts/tests/rust-napi-fixtures.test.mjs",
    ],
    "fixture prepared",
    ["gateway:test"],
    ["--filter", "xiaowei-rust", "test"],
    ["--dir", "desktop", "test"],
  ]);
});

test("failed fixture preparation prevents consumer tests and still checks artifact integrity", async () => {
  let checks = 0;
  const failure = new Error("fixture build failed");
  await assert.rejects(
    testPrebuilt({
      hashes: () => {
        checks += 1;
        return ["unchanged"];
      },
      run: (args) => assert.ok(!args.includes("test")),
      fixtures: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(checks, 2);
});

test("changed production addon aborts release even when tests pass", async () => {
  let checks = 0;
  await assert.rejects(
    testPrebuilt({
      hashes: () => [String(checks++)],
      run() {},
      fixtures: async (_packages, tests) => tests(),
    }),
    /Production release addons changed/,
  );
});

test("test failure and overwritten production addon are both reported", async () => {
  let checks = 0;
  const failure = new Error("tests failed");
  await assert.rejects(
    testPrebuilt({
      hashes: () => [String(checks++)],
      run: () => {
        throw failure;
      },
      fixtures: () => assert.fail("checks failed before fixtures"),
    }),
    (error) =>
      error instanceof AggregateError && error.errors[0] === failure && error.errors.length === 2,
  );
});

test("hashes cover both package binaries and missing binaries fail before tests", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-release-hashes-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const binaries = ["agent", "rust"].map((name) => {
    const output = join(directory, "crates", `xiaowei-${name}`, "napi");
    mkdirSync(output, { recursive: true });
    const binary = join(output, `xiaowei-${name}.darwin-arm64.node`);
    writeFileSync(binary, name);
    return binary;
  });
  const before = nativeHashes(directory);
  assert.equal(before.length, 2);
  for (const [index, binary] of binaries.entries()) {
    writeFileSync(binary, "changed");
    assert.notEqual(nativeHashes(directory)[index], before[index]);
  }
  rmSync(binaries[1]);
  assert.throws(() => nativeHashes(directory), /ENOENT/);
});
