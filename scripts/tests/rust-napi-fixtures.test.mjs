import assert from "node:assert/strict";
import { test } from "node:test";
import { withRustNapiFixtures } from "./rust-napi-fixtures.mjs";

test("a failed fixture build restores all addons before checking production artifacts", async () => {
  const calls = [];
  const failure = new Error("fixture build failed");
  await assert.rejects(
    withRustNapiFixtures(["search", "clipboard"], () => assert.fail("tests must not run"), {
      run(args) {
        calls.push(args);
        if (args.includes("gateway-fixtures")) throw failure;
      },
      verify(packages) {
        assert.deepEqual(packages, ["search", "clipboard"]);
        calls.push("verify");
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls.slice(1), [
    ["--filter", "xiaowei-search", "build:debug"],
    ["--filter", "xiaowei-clipboard", "build:debug"],
    "verify",
  ]);
});

test("test and restoration failures are both reported without skipping later cleanup", async () => {
  const failure = new Error("tests failed");
  const restore = new Error("search restore failed");
  const calls = [];
  await assert.rejects(
    withRustNapiFixtures(
      ["search", "clipboard"],
      async () => {
        await Promise.resolve();
        throw failure;
      },
      {
        run(args) {
          if (args.includes("gateway-fixtures")) return;
          calls.push(args[1]);
          if (args[1] === "xiaowei-search") throw restore;
        },
        verify() {
          calls.push("verify");
        },
      },
    ),
    (error) => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === restore,
  );
  assert.deepEqual(calls, ["xiaowei-search", "xiaowei-clipboard", "verify"]);
});
