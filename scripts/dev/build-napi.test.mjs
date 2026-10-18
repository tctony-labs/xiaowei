import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-napi.mjs", import.meta.url));

function build(
  t,
  args,
  {
    platform = "darwin",
    buildStatus = 0,
    stripStatus = 0,
    symbolStatus = 0,
    mismatch = false,
  } = {},
) {
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
    let buildEnvironment;
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    childProcess.spawnSync = (command, args, options) => {
      calls.push([command, ...args]);
      if (command === "pnpm") {
        buildEnvironment = {
          debug: options.env.CARGO_PROFILE_RELEASE_DEBUG,
          split: options.env.CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO,
          strip: options.env.CARGO_PROFILE_RELEASE_STRIP,
        };
        return { status: ${buildStatus} };
      }
      if (command !== "xcrun") throw new Error("Unexpected command: " + command);
      if (args[0] === "dsymutil") return { status: ${symbolStatus} };
      if (${stripStatus} === 0) truncateSync(args.at(-1), 512);
      return { status: ${stripStatus} };
    };
    childProcess.execFileSync = (command, args) => {
      calls.push([command, ...args]);
      const uuid = ${mismatch} && args.at(-1).endsWith(".dSYM")
        ? "22222222-2222-2222-2222-222222222222"
        : "11111111-1111-1111-1111-111111111111";
      return "UUID: " + uuid + " (" + process.arch + ") " + args.at(-1);
    };
    syncBuiltinESMExports();
    process.on("exit", () => writeFileSync(
      ${JSON.stringify(callsFile)}, JSON.stringify({ calls, buildEnvironment }),
    ));
    await import(${JSON.stringify(new URL("./build-napi.mjs", import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  return { ...result, binary, ...JSON.parse(readFileSync(callsFile, "utf8")) };
}

test("macOS release collects matching dSYM before stripping and preserves its UUID", (t) => {
  const result = build(t, ["--release"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["pnpm", "exec", "napi", "build", "--platform", "--release"],
    ["xcrun", "dsymutil", result.binary, "-o", `${result.binary}.dSYM`],
    ["xcrun", "dwarfdump", "--uuid", result.binary],
    ["xcrun", "dwarfdump", "--uuid", `${result.binary}.dSYM`],
    ["xcrun", "strip", "-x", result.binary],
    ["xcrun", "dwarfdump", "--uuid", result.binary],
    ["xcrun", "dwarfdump", "--uuid", `${result.binary}.dSYM`],
  ]);
  assert.deepEqual(result.buildEnvironment, { debug: "2", split: "unpacked", strip: "none" });
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
  assert.equal(result.calls.length, 5);
  assert.doesNotMatch(result.stdout, /Stripped local symbols/);
});

test("dSYM generation failure prevents stripping", (t) => {
  const result = build(t, ["--release"], { symbolStatus: 8 });
  assert.equal(result.status, 8);
  assert.equal(result.calls.length, 2);
});

test("a mismatched dSYM prevents stripping and reports the addon", (t) => {
  const result = build(t, ["--release"], { mismatch: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dSYM UUID mismatch:.*test-addon/);
  assert.ok(!result.calls.some((call) => call.includes("strip")));
});
