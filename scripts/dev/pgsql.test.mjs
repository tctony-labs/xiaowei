import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { restart, start, status, stop } from "./pgsql.mjs";

function configuration(context) {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-db-"));
  mkdirSync(join(root, "server/config"), { recursive: true });
  writeFileSync(join(root, "server/config/.env"), "");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("PostgreSQL lifecycle needs only dotenv, shares one Compose project and preserves volumes", async (context) => {
  const root = configuration(context);
  const calls = [];
  const options = { root, print: () => {}, run: async (...args) => calls.push(args) };
  await start(options);
  await stop(options);
  await restart(options);
  await status(options);
  const prefix = [
    "compose",
    "--env-file",
    "server/config/.env",
    "-p",
    "xiaowei-dev",
    "-f",
    "server/deploy/compose.yaml",
  ];
  assert.deepEqual(
    calls.map(([, args]) => args.slice(prefix.length)),
    [
      ["up", "-d", "--wait", "--wait-timeout", "60", "db"],
      ["stop", "db"],
      ["stop", "db"],
      ["up", "-d", "--wait", "--wait-timeout", "60", "db"],
      ["ps", "--all", "db"],
    ],
  );
  for (const [command, args, { cwd }] of calls) {
    assert.equal(command, "docker");
    assert.equal(cwd, root);
    assert.deepEqual(args.slice(0, prefix.length), prefix);
    assert.ok(!args.includes("down") && !args.includes("--volumes"));
  }
});

test("restart does not start PostgreSQL if stopping fails", async (context) => {
  const root = configuration(context);
  const calls = [];
  await assert.rejects(
    restart({
      root,
      print: () => {},
      run: async (_command, args) => {
        calls.push(args);
        throw new Error("Docker unavailable");
      },
    }),
    /Docker unavailable/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-2), ["stop", "db"]);
});

test("missing environment template prevents PostgreSQL startup", async (context) => {
  const root = configuration(context);
  rmSync(join(root, "server/config/.env"));
  let calls = 0;
  await assert.rejects(start({ root, print: () => {}, run: async () => calls++ }), /ENOENT/);
  assert.equal(calls, 0);
});

test("just db forwards all lifecycle commands and propagates failures", (context) => {
  const root = configuration(context);
  writeFileSync(
    join(root, "server/config/.env.example"),
    "XIAOWEI_DATABASE_PASSWORD=fixture-password",
  );
  rmSync(join(root, "server/config/.env"));
  const scriptDirectory = join(root, "scripts/dev");
  mkdirSync(scriptDirectory, { recursive: true });
  for (const name of ["pgsql.mjs", "dev-process.mjs", "server-config.mjs"]) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(scriptDirectory, name));
  }
  copyFileSync(fileURLToPath(new URL("../../justfile", import.meta.url)), join(root, "justfile"));
  const log = join(root, "docker-arguments.jsonl");
  writeFileSync(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.DB_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.DB_TEST_EXIT || 0));
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH}`,
    DB_TEST_LOG: log,
  };
  for (const command of ["start", "stop", "restart", "status"]) {
    const result = spawnSync("just", ["db", command], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(
    readFileSync(join(root, "server/config/.env"), "utf8"),
    "XIAOWEI_DATABASE_PASSWORD=fixture-password",
  );
  assert.equal(existsSync(join(root, "server/config/server.yaml")), false);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((args) => args.slice(7)[0]),
    ["up", "stop", "stop", "up", "ps"],
  );
  const failed = spawnSync("just", ["db", "start"], {
    cwd: root,
    env: { ...env, DB_TEST_EXIT: "1" },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /PostgreSQL 操作失败/);
  for (const args of [[], ["unknown"], ["status", "unexpected"]]) {
    const result = spawnSync("just", ["db", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /用法：just db/);
  }
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 6);
});
