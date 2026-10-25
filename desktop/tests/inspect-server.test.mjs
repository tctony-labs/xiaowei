import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { INSPECT_MAX_BYTES } from "../src/main/services/inspect/protocol.ts";
import { startInspectServer } from "../src/main/services/inspect/server.ts";
import { ensureInspectDirectory, inspectSocketPath } from "../src/main/services/inspect/target.ts";
import { callInspect, rawRequest } from "./inspect-test-client.mjs";

async function fixture(t, overrides = {}) {
  const path = await realpath(await mkdtemp("/tmp/xwi-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let changes = 0;
  const methods = new Map([
    ["app.status", { description: "Status", mutates: false, params: {}, run: () => ({ changes }) }],
    [
      "launcher.show",
      {
        description: "Show",
        mutates: true,
        params: { mode: { type: "string", required: true, values: ["search", "quick-chat"] } },
        run: ({ mode }) => ({ changes: ++changes, mode }),
      },
    ],
  ]);
  const source = { kind: "workspace", path };
  const server = await startInspectServer({ source, methods, ...overrides });
  t.after(() => server.close());
  const call = (method, params, changes) => callInspect(server, method, params, changes);
  return { server, methods, call };
}

test("source hashing agrees with the Rust contract, including spaces and Unicode", async () => {
  const fixtures = JSON.parse(
    await readFile(new URL("../inspect/tests/fixtures/targets.json", import.meta.url), "utf8"),
  );
  for (const { source, uid, socket } of fixtures) {
    assert.equal(inspectSocketPath(source, uid), socket);
  }
});

test("server validates identity and parameters before changing hidden state", async (t) => {
  const { call, server } = await fixture(t);
  assert.deepEqual(await call("app.status"), { changes: 0 });
  assert.equal((await lstat(server.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(server.path))).mode & 0o077, 0);
  for (const params of [{}, { mode: "bad" }, { mode: "search", extra: true }]) {
    await assert.rejects(call("launcher.show", params), { code: "INVALID_PARAMS" });
  }
  for (const changes of [
    { source: { ...server.source, path: "/another-workspace" } },
    { source: { ...server.source, kind: "app" } },
  ]) {
    await assert.rejects(call("launcher.show", { mode: "search" }, changes), {
      code: "SOURCE_MISMATCH",
    });
  }
  await assert.rejects(call("unknown"), { code: "UNKNOWN_METHOD" });
  assert.deepEqual(await call("app.status"), { changes: 0 });
  assert.deepEqual(await call("launcher.show", { mode: "quick-chat" }), {
    changes: 1,
    mode: "quick-chat",
  });
});

test("protocol and malformed requests fail without dispatch", async (t) => {
  const { call, server } = await fixture(t);
  for (const [changes, code] of [
    [{ protocol: "other" }, "VERSION_MISMATCH"],
    [{ version: 2 }, "VERSION_MISMATCH"],
    [{ id: 1 }, "INVALID_REQUEST"],
    [{ params: [] }, "INVALID_REQUEST"],
    [{ extra: true }, "INVALID_REQUEST"],
  ]) {
    await assert.rejects(call("launcher.show", { mode: "search" }, changes), { code });
  }
  assert.equal((await rawRequest(server.path, "{bad JSON}\n")).error.code, "INVALID_JSON");
  const large = await rawRequest(server.path, Buffer.alloc(INSPECT_MAX_BYTES + 1, 97));
  assert.equal(large.error.code, "FRAME_TOO_LARGE");
  assert.deepEqual(await call("app.status"), { changes: 0 });
});

test("startup preserves a live listener and refuses files or unsafe directories", async (t) => {
  const { server, methods, call } = await fixture(t);
  const before = await lstat(server.path);
  await assert.rejects(startInspectServer({ source: server.source, methods }), /already serving/);
  assert.equal((await lstat(server.path)).ino, before.ino);
  assert.deepEqual(await call("app.status"), { changes: 0 });
  await server.close();
  await writeFile(server.path, "keep this file");
  t.after(() => rm(server.path, { force: true }));
  await assert.rejects(startInspectServer({ source: server.source, methods }), /not an owned/);
  assert.equal(await readFile(server.path, "utf8"), "keep this file");

  const directory = await mkdtemp("/tmp/xwi-permissions-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  await assert.rejects(ensureInspectDirectory(directory), { code: "UNSAFE_SOCKET" });
  const link = `${directory}-link`;
  await symlink(directory, link);
  t.after(() => rm(link));
  await assert.rejects(ensureInspectDirectory(link), { code: "UNSAFE_SOCKET" });
});

test("startup recovers an owned stale socket outside application data", async (t) => {
  const { server, methods } = await fixture(t);
  const source = server.source;
  const path = server.path;
  await server.close();
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createServer } from "node:net";
createServer().listen(process.argv[1], () => {
  process.exit(0);
});`,
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const replacement = await startInspectServer({ source, methods });
  t.after(() => replacement.close());
  assert.deepEqual(await callInspect(replacement, "app.status"), { changes: 0 });
});

test("timeouts do not let expired mutations run after an earlier owner completes", async (t) => {
  const calls = [];
  let finish;
  const methods = new Map([
    [
      "mutate",
      {
        description: "Deferred mutation",
        mutates: true,
        params: {},
        run: () => {
          calls.push("ran");
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    ],
  ]);
  const { call } = await fixture(t, { methods, timeoutMs: 50 });
  const first = assert.rejects(call("mutate"), { code: "TIMEOUT" });
  await new Promise(setImmediate);
  const second = assert.rejects(call("mutate"), { code: "TIMEOUT" });
  await Promise.all([first, second]);
  finish({ completed: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["ran"]);
});

test("owner failures and oversized results have structured errors", async (t) => {
  const methods = new Map([
    [
      "broken",
      {
        description: "Failure",
        mutates: false,
        params: {},
        run() {
          throw new Error("owner unavailable");
        },
      },
    ],
    [
      "large",
      {
        description: "Large",
        mutates: false,
        params: {},
        run: () => "x".repeat(INSPECT_MAX_BYTES),
      },
    ],
  ]);
  const { call } = await fixture(t, { methods });
  await assert.rejects(call("broken"), { code: "HANDLER_ERROR", message: "owner unavailable" });
  await assert.rejects(call("large"), { code: "FRAME_TOO_LARGE" });
});

test("shutdown is repeatable, closes idle clients and removes its socket", async (t) => {
  const { server, call } = await fixture(t);
  await call("app.status");
  const closing = server.close();
  assert.equal(server.close(), closing);
  await closing;
  await assert.rejects(lstat(server.path), { code: "ENOENT" });
});
