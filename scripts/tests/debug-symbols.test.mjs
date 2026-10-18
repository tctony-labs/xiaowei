import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createPackageWithOptions } from "@electron/asar";
import {
  archiveDebugSymbols,
  electronSymbols,
  verifySourceMap,
} from "../release/debug-symbols.mjs";
import { nativeUuid, verifyNativeSymbols } from "../release/native-symbols.mjs";

const uuid = "11111111-1111-1111-1111-111111111111";
const macOnly = { skip: process.platform !== "darwin" || process.arch !== "arm64" };
const map = {
  version: 3,
  file: "index.js",
  sources: ["index.ts"],
  sourcesContent: ["const value: number = 1;"],
  names: [],
  mappings: "AAAA",
};
const checksums = ["dsym.tar.xz", "symbols.zip"]
  .map((suffix) => `${"a".repeat(64)}  electron-v44.3.0-darwin-arm64-${suffix}`)
  .join("\n");

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-debug-symbols-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function mockTools(t, { mismatch = false, architecture = "arm64" } = {}) {
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (command, args, options) =>
    command === "xcodebuild" ? { status: 1, stdout: "" } : spawn(command, args, options),
  );
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    if (command === "xcrun" && args[0] === "--show-sdk-version") return "26.2";
    if (command === "xcrun") {
      const id = mismatch && args.at(-1).endsWith(".dSYM") ? uuid.replaceAll("1", "2") : uuid;
      return `UUID: ${id} (${architecture}) ${args.at(-1)}`;
    }
    if (command.endsWith("PlistBuddy")) return args[1].includes("Short") ? "0.1.2" : "44.3.0";
    if (command === "curl") return checksums;
    if (command === "git") return args[0] === "rev-parse" ? "test-commit" : "";
    if (command === "rustc" || command === "xcodebuild") return "test-toolchain";
    throw new Error(`Unexpected command: ${command}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("Electron symbols select exact platform assets and require both official checksums", () => {
  const assets = electronSymbols("44.3.0", checksums);
  assert.equal(assets.length, 2);
  assert.match(assets[0].url, /\/v44\.3\.0\/electron-v44\.3\.0-darwin-arm64-dsym\.tar\.xz$/);
  assert.equal(assets[0].sha256, "a".repeat(64));
  assert.throws(() => electronSymbols("44.3.1", checksums), /Missing Electron symbol checksum/);
  assert.throws(() => electronSymbols("44.3.0", checksums.split("\n")[0]), /symbols.zip/);
});

test("source maps require embedded source, matching output names and no public reference", (t) => {
  const path = join(temporary(t), "index.js.map");
  writeFileSync(path, JSON.stringify(map));
  verifySourceMap(path, "const value=1;");
  assert.throws(() => verifySourceMap(path, "//# sourceMappingURL=index.js.map"), /hidden/);
  for (const invalid of [
    { ...map, file: "old.js" },
    { ...map, sourcesContent: null },
    { ...map, sourcesContent: [null] },
    { ...map, mappings: "" },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(() => verifySourceMap(path, "const value=1;"), /Incomplete source map/);
  }
  writeFileSync(path, JSON.stringify({ ...map, sources: [], sourcesContent: [], mappings: "" }));
  verifySourceMap(path, "generatedHelper();");
});

test("native matching rejects the wrong UUID and architecture", (t) => {
  mockTools(t, { mismatch: true });
  assert.equal(nativeUuid("addon.node", "arm64"), uuid);
  assert.throws(() => verifyNativeSymbols("addon.node", "addon.node.dSYM", "arm64"), /mismatch/);
  assert.throws(() => nativeUuid("addon.node", "x64"), /Expected one x64 UUID/);
});

async function fixture(t) {
  const root = temporary(t);
  const desktop = join(root, "desktop");
  const source = join(root, "asar-source");
  const app = join(desktop, "dist/mac-arm64/XiaoWei.app");
  const files = {
    "package.json": JSON.stringify({
      type: "module",
      main: "out/main/index.js",
      dependencies: { "xiaowei-agent": "workspace:*", "xiaowei-rust": "workspace:*" },
    }),
    "out/main/index.js": "const main=1;",
    "out/main/llm-worker.js": "const worker=1;",
    "out/main/chunks/provider.js": "const provider=1;",
    "out/preload/index.cjs": "const preload=1;",
    "out/renderer/index.html": "<!doctype html>",
    "out/renderer/assets/index.js": "const renderer=1;",
  };
  for (const name of ["xiaowei-agent", "xiaowei-rust"]) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, main: "index.js" });
    files[`node_modules/${name}/index.js`] = "module.exports={};";
    files[`node_modules/${name}/${name}.darwin-arm64.node`] = `signed-${name}`;
    write(
      join(root, "crates", name, "napi", `${name}.darwin-arm64.node.dSYM/Contents/Info.plist`),
      "dSYM fixture",
    );
  }
  for (const [path, content] of Object.entries(files)) {
    write(join(source, path), content);
    if (!/^out\/.*\.(?:js|cjs)$/.test(path)) continue;
    write(join(desktop, path), content);
    write(join(desktop, `${path}.map`), JSON.stringify({ ...map, file: path.split("/").at(-1) }));
  }
  write(
    join(desktop, "package.json"),
    JSON.stringify({
      version: "0.1.2",
      devDependencies: { electron: "44.3.0" },
    }),
  );
  const asar = join(app, "Contents/Resources/app.asar");
  mkdirSync(dirname(asar), { recursive: true });
  await createPackageWithOptions(source, asar, { unpack: "**/*.node" });
  return { app, desktop, files };
}

test(
  "archive contains the packaged binaries, every JS chunk and map, and a checksum inventory",
  macOnly,
  async (t) => {
    const { app, desktop } = await fixture(t);
    const unzip = execFileSync;
    mockTools(t);
    const archive = archiveDebugSymbols(app, desktop);
    assert.equal(archive, join(desktop, "dist/XiaoWei-0.1.2-arm64-debug-symbols.zip"));
    const prefix = "XiaoWei-0.1.2-arm64-debug-symbols/";
    const manifest = JSON.parse(unzip("unzip", ["-p", archive, `${prefix}manifest.json`]));
    assert.equal(manifest.sourceMaps, 5);
    assert.equal(manifest.toolchains.xcode, null);
    assert.equal(manifest.toolchains.macosSdk, "26.2");
    assert.equal(manifest.native.length, 2);
    assert.equal(manifest.electron.symbols.length, 2);
    for (const [path, digest] of Object.entries(manifest.files)) {
      const content = unzip("unzip", ["-p", archive, `${prefix}${path}`]);
      assert.equal(createHash("sha256").update(content).digest("hex"), digest, path);
    }
    assert.equal(manifest.files["javascript/out/main/chunks/provider.js.map"].length, 64);
    const binary = unzip("unzip", [
      "-p",
      archive,
      `${prefix}native/xiaowei-rust.darwin-arm64.node`,
    ]);
    assert.equal(binary.toString(), "signed-xiaowei-rust");
  },
);

test(
  "missing maps and changed build outputs cannot produce a debug archive",
  macOnly,
  async (t) => {
    const { app, desktop } = await fixture(t);
    mockTools(t);
    const archive = join(desktop, "dist/XiaoWei-0.1.2-arm64-debug-symbols.zip");
    writeFileSync(archive, "previous archive");
    const path = join(desktop, "out/main/index.js");
    writeFileSync(path, "stale build");
    assert.throws(() => archiveDebugSymbols(app, desktop), /Packaged JS differs/);
    writeFileSync(path, "const main=1;");
    rmSync(`${path}.map`);
    assert.throws(() => archiveDebugSymbols(app, desktop), /ENOENT/);
    assert.equal(readFileSync(archive, "utf8"), "previous archive");
  },
);
