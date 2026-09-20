import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSourceLocation, sourceLog } from "../runtime.ts";

test("helper preserves format strings, object identity, Error and spread arguments", (context) => {
  const calls = [];
  context.mock.method(console, "info", (...args) => calls.push(args));
  const error = new Error("failure");
  const object = { count: 2 };
  sourceLog("info", "packages/example/src/index.ts:5", "%s %o", "hello", object, error);
  sourceLog("info", "packages/example/src/index.ts:6", object, error);
  assert.deepEqual(calls[0], ["[packages/example/src/index.ts:5] %s %o", "hello", object, error]);
  assert.deepEqual(calls[1], ["[packages/example/src/index.ts:6]", object, error]);
  assert.equal(hasSourceLocation(calls[0][0]), true);
  assert.equal(hasSourceLocation("ordinary message (bundle.js:1)"), false);
});
