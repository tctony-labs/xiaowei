import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { root, withRustNapiFixtures } from "./rust-napi-fixtures.mjs";

const production = (name) => ["--filter", `xiaowei-${name}`, "build:debug"];
const fixture = (name) => [
  ...production(name),
  "--features",
  "gateway-fixtures",
  "--output-dir",
  `../../../target/rust-napi-tests/${name}`,
];

test("standalone tests prepare separate production and fixture addons without restoration", async () => {
  const calls = [];
  await withRustNapiFixtures(["search", "clipboard"], () => calls.push("tests"), {
    prepared: false,
    run: (args) => calls.push(args),
    writePackage: (name) => calls.push(`package:${name}`),
    verify(packages) {
      assert.deepEqual(packages, ["search", "clipboard"]);
      calls.push("verify");
    },
  });

  assert.deepEqual(calls, [
    production("search"),
    production("clipboard"),
    "verify",
    fixture("search"),
    "package:search",
    fixture("clipboard"),
    "package:clipboard",
    "tests",
    "verify",
  ]);
});

test("workspace preparation builds fixtures without repeating the production build", async () => {
  const calls = [];
  await withRustNapiFixtures(["search"], () => calls.push("tests"), {
    prepared: false,
    productionPrepared: true,
    run: (args) => calls.push(args),
    writePackage: (name) => calls.push(`package:${name}`),
    verify: () => calls.push("verify"),
  });

  assert.deepEqual(calls, ["verify", fixture("search"), "package:search", "tests", "verify"]);
});

test("workspace children reuse prepared addons and still check production exports", async () => {
  const calls = [];
  await withRustNapiFixtures(["search"], () => calls.push("tests"), {
    prepared: true,
    run: () => assert.fail("prepared tests must not rebuild addons"),
    writePackage: () => assert.fail("prepared tests must not rewrite fixture packages"),
    verify: () => calls.push("verify"),
  });

  assert.deepEqual(calls, ["verify", "tests", "verify"]);
});

test("fixture directory loaders work in plain Node inside the ESM workspace", async (context) => {
  const name = `loader-${randomUUID()}`;
  const directory = join(root, "target/rust-napi-tests", name);
  const require = createRequire(import.meta.url);
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  await withRustNapiFixtures(
    [name],
    () => {
      assert.deepEqual(require(directory), { fixture: true });
    },
    {
      prepared: false,
      productionPrepared: true,
      run() {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "index.js"), "module.exports = { fixture: true };\n");
      },
      verify() {},
    },
  );
});

test("a failed fixture build checks production artifacts without rebuilding or running tests", async () => {
  const calls = [];
  const failure = new Error("fixture build failed");
  await assert.rejects(
    withRustNapiFixtures(["search", "clipboard"], () => assert.fail("tests must not run"), {
      prepared: false,
      productionPrepared: true,
      run(args) {
        calls.push(args);
        throw failure;
      },
      verify: () => calls.push("verify"),
    }),
    (error) => error === failure,
  );

  assert.deepEqual(calls, ["verify", fixture("search"), "verify"]);
});

test("test and production check failures are both reported without a restoration build", async () => {
  const failure = new Error("tests failed");
  const check = new Error("production addon contains fixture exports");
  let checks = 0;
  await assert.rejects(
    withRustNapiFixtures(
      ["search", "clipboard"],
      async () => {
        throw failure;
      },
      {
        prepared: true,
        run: () => assert.fail("prepared tests must not rebuild addons"),
        verify() {
          checks += 1;
          if (checks === 2) throw check;
        },
      },
    ),
    (error) => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === check,
  );

  assert.equal(checks, 2);
});
