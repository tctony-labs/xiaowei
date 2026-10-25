import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createPackageWithOptions } from "@electron/asar";
import { nativePackages, verifyPackageContent } from "../release/verify-package-content.mjs";

async function fixture(
  t,
  { extra = {}, missing, unpack = true, dependencies = nativePackages } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "xiaowei-package-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const app = join(directory, "XiaoWei.app");
  const archive = join(app, "Contents/Resources/app.asar");
  const files = {
    "package.json": JSON.stringify({
      type: "module",
      main: "out/main/index.js",
      dependencies: Object.fromEntries(dependencies.map((name) => [name, "1.0.0"])),
    }),
    "out/main/index.js": "export {};",
    "out/main/llm-worker.js": "export {};",
    "out/main/chunks/provider.js": "export {};",
    "out/preload/index.cjs": "module.exports = {};",
    "out/renderer/index.html": "<!doctype html>",
    "out/renderer/assets/index.js": "console.log('renderer');",
    "out/renderer/assets/icon.png": "image fixture",
  };
  for (const name of nativePackages) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, main: "index.js" });
    files[`node_modules/${name}/index.js`] = "module.exports = {};";
    files[`node_modules/${name}/${name}.darwin-arm64.node`] = "binary fixture";
  }
  Object.assign(files, extra);
  delete files[missing];
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  await mkdir(dirname(archive), { recursive: true });
  await createPackageWithOptions(source, archive, unpack ? { unpack: "**/*.node" } : {});
  const inspect = join(app, "Contents/Resources/bin/xiaowei-inspect");
  await mkdir(dirname(inspect), { recursive: true });
  await writeFile(inspect, "native CLI fixture", { mode: 0o755 });
  return { app, archive, files };
}

test("real ASAR accepts only built outputs, metadata and native runtime files", async (t) => {
  const { app, files } = await fixture(t);
  assert.deepEqual(verifyPackageContent(app).sort(), Object.keys(files).sort());
});

test("missing, non-executable or linked inspect CLI fails package acceptance", async (t) => {
  const { app } = await fixture(t);
  const inspect = join(app, "Contents/Resources/bin/xiaowei-inspect");
  await chmod(inspect, 0o644);
  assert.throws(() => verifyPackageContent(app), /Missing executable inspect CLI/);
  await rm(inspect);
  assert.throws(() => verifyPackageContent(app), /Missing executable inspect CLI/);
  const external = `${inspect}-external`;
  await writeFile(external, "external", { mode: 0o755 });
  await symlink(external, inspect);
  assert.throws(() => verifyPackageContent(app), /Missing executable inspect CLI/);
});

for (const path of [
  "node_modules/openai/index.js",
  "node_modules/xiaowei-storage/index.js",
  "node_modules/xiaowei-gateway/src/index.ts",
  "node_modules/xiaowei-agent/src/lib.rs",
  "node_modules/xiaowei-agent/index.d.ts",
  "node_modules/xiaowei-agent/Cargo.toml",
  "node_modules/xiaowei-rust/xiaowei-rust.darwin-x64.node",
  "src/main/index.js",
  "out/main/index.js.map",
  "out/main/chunks/extra.d.mts",
]) {
  test(`real ASAR rejects undeclared runtime content: ${path}`, async (t) => {
    const { app } = await fixture(t, { extra: { [path]: "unexpected" } });
    assert.throws(() => verifyPackageContent(app), { message: `Unexpected package file: ${path}` });
  });
}

test("inline source maps are rejected even without a .map file", async (t) => {
  const { app } = await fixture(t, {
    extra: {
      "out/main/index.js": "export {};\n//# sourceMappingURL=data:application/json;base64,e30=",
    },
  });
  assert.throws(() => verifyPackageContent(app), /Unexpected source map reference/);
});

test("missing native loader and packed native binaries fail acceptance", async (t) => {
  const { app } = await fixture(t, { missing: "node_modules/xiaowei-agent/index.js" });
  assert.throws(() => verifyPackageContent(app), /Missing package files:.*xiaowei-agent\/index.js/);
  const packed = await fixture(t, { unpack: false });
  assert.throws(() => verifyPackageContent(packed.app), /Native binary must be unpacked/);
});

test("undeclared production dependencies fail even when no files were collected", async (t) => {
  const { app } = await fixture(t, { dependencies: [...nativePackages, "electron-log"] });
  assert.throws(
    () => verifyPackageContent(app),
    /Unexpected production dependencies:.*electron-log/,
  );
});

test("unpacked files outside the ASAR manifest cannot escape the boundary check", async (t) => {
  const { app, archive } = await fixture(t);
  await writeFile(`${archive}.unpacked/unexpected.js`, "unexpected");
  assert.throws(() => verifyPackageContent(app), /Unexpected unpacked file: unexpected.js/);
});

test("missing unpacked native files fail acceptance", async (t) => {
  const { app, archive } = await fixture(t);
  const binary = `${archive}.unpacked/node_modules/xiaowei-agent/xiaowei-agent.darwin-arm64.node`;
  await rm(binary);
  assert.throws(() => verifyPackageContent(app), /Missing unpacked files/);
});
