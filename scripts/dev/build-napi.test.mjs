import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-napi.mjs", import.meta.url));

function build(t, args, { platform = "darwin", buildStatus = 0, stripStatus = 0 } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xiaowei-build-napi-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory);
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ napi: { binaryName: "test-addon" } }),
  );
  const binary = join(packageDirectory, `test-addon.darwin-${process.arch}.node`);
  writeFileSync(binary, Buffer.alloc(1024));
  const callsFile = join(directory, "calls.json");
  const prelude = `
    import childProcess from "node:child_process";
    import { truncateSync, writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const calls = [];
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    childProcess.spawnSync = (command, args) => {
      calls.push([command, ...args]);
      if (command === "pnpm") return { status: ${buildStatus} };
      if (command !== "xcrun") throw new Error("Unexpected command: " + command);
      if (${stripStatus} === 0) truncateSync(args.at(-1), 512);
      return { status: ${stripStatus} };
    };
    syncBuiltinESMExports();
    process.on("exit", () => writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls)));
    await import(${JSON.stringify(new URL("./build-napi.mjs", import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  return { ...result, binary, calls: JSON.parse(readFileSync(callsFile, "utf8")) };
}

test("macOS release strips the built addon and reports the resulting size", (t) => {
  const result = build(t, ["--release"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["pnpm", "exec", "napi", "build", "--platform", "--release"],
    ["xcrun", "strip", "-x", result.binary],
  ]);
  assert.match(result.stdout, /test-addon.*1024 -> 512 bytes/);
});

test("debug and non-macOS release builds do not strip native symbols", (t) => {
  for (const [args, platform] of [
    [[], "darwin"],
    [["--release"], "linux"],
  ]) {
    const result = build(t, args, { platform });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
  }
});

test("failed native builds stop before stripping and preserve the failure status", (t) => {
  const result = build(t, ["--release"], { buildStatus: 7 });
  assert.equal(result.status, 7);
  assert.equal(result.calls.length, 1);
});

test("strip failure fails the release build and reports no successful size reduction", (t) => {
  const result = build(t, ["--release"], { stripStatus: 9 });
  assert.equal(result.status, 9);
  assert.equal(result.calls.length, 2);
  assert.doesNotMatch(result.stdout, /bytes/);
});
