import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./go-cache.mjs", import.meta.url));

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-go-cache-"));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const inputs = {
    "server/go.mod": "module example/server\n\ngo 1.26.0\n\ntoolchain go1.26.5\n",
    "server/go.sum": "// server dependencies\n",
    "server/main.go": "package main\n\nfunc main() {}\n",
    "server/internal/db/migrations/first.sql": "SELECT 1;\n",
    "contracts/go/go.mod": "module example/contracts\n\ngo 1.26.0\n",
    "contracts/go/go.sum": "// contract dependencies\n",
    "contracts/go/codec.go": "package contracts\n",
    "desktop/example.tsx": "// renderer\n",
    ".github/workflows/test.yml": "name: test\n",
    "scripts/ci/go-cache.mjs": "// cache script\n",
  };
  for (const [path, contents] of Object.entries(inputs)) {
    const absolute = join(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const env = {
    ...process.env,
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOMODCACHE: join(directory, "modules"),
    GOCACHE: join(directory, "builds"),
    RUNNER_OS: "testOS",
    RUNNER_ARCH: "testArch",
  };
  const run = (mode, overrides = {}) => {
    const result = spawnSync(process.execPath, [script, mode], {
      cwd: workspace,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };
  return { workspace, env, run };
}

test("toolchain overrides the minimum Go version, with a fallback when absent", (context) => {
  const { workspace, run } = fixture(context);
  assert.equal(run("version").version, "1.26.5");
  const manifest = join(workspace, "server/go.mod");
  writeFileSync(manifest, "module example/server\n\ngo 1.26.0\n");
  assert.equal(run("version").version, "1.26.0");
  writeFileSync(manifest, "module example/server\n\ngo 1.26.0\n\ntoolchain default\n");
  assert.equal(run("version").version, "1.26.0");
});

test("cache paths and prefixes reflect the actual Go environment and runner", (context) => {
  const { env, run } = fixture(context);
  const outputs = run("key");
  const version = execFileSync("go", ["env", "GOVERSION"], { env, encoding: "utf8" }).trim();
  assert.equal(outputs["module-path"], env.GOMODCACHE);
  assert.equal(outputs["build-path"], env.GOCACHE);
  assert.equal(outputs.prefix, `go-v1-testOS-testArch-${version}`);
  assert.notEqual(run("key", { RUNNER_OS: "differentOS" }).prefix, outputs.prefix);
  assert.notEqual(run("key", { RUNNER_ARCH: "differentArch" }).prefix, outputs.prefix);
});

test("both modules' dependency changes rotate module and build snapshots", (context) => {
  const { workspace, run } = fixture(context);
  const first = run("key");
  for (const path of ["server/go.mod", "server/go.sum", "contracts/go/go.mod", "contracts/go/go.sum"]) {
    const absolute = join(workspace, path);
    const original = readFileSync(absolute, "utf8");
    writeFileSync(absolute, `${original}\n// changed\n`);
    const changed = run("key");
    assert.notEqual(changed["module-hash"], first["module-hash"], path);
    assert.notEqual(changed["build-hash"], first["build-hash"], path);
    assert.equal(changed.prefix, first.prefix, path);
    writeFileSync(absolute, original);
  }
});

test("Go sources, SQL migrations and CI logic rotate only the build snapshot", (context) => {
  const { workspace, run } = fixture(context);
  const first = run("key");
  const inputs = [
    "server/main.go",
    "contracts/go/codec.go",
    "server/internal/db/migrations/first.sql",
    ".github/workflows/test.yml",
    "scripts/ci/go-cache.mjs",
  ];
  for (const path of inputs) {
    const absolute = join(workspace, path);
    const original = readFileSync(absolute, "utf8");
    writeFileSync(absolute, `${original}\n// changed\n`);
    const changed = run("key");
    assert.equal(changed["module-hash"], first["module-hash"], path);
    assert.notEqual(changed["build-hash"], first["build-hash"], path);
    assert.equal(changed.prefix, first.prefix, path);
    writeFileSync(absolute, original);
  }
});

test("timestamps, renderer and untracked files retain keys, while added tracked Go files rotate builds", (context) => {
  const { workspace, run } = fixture(context);
  const first = run("key");
  const source = join(workspace, "server/main.go");
  const later = statSync(source).mtimeMs / 1000 + 10000;
  utimesSync(source, later, later);
  writeFileSync(join(workspace, "desktop/example.tsx"), "// changed renderer\n");
  writeFileSync(join(workspace, "server/added.go"), "package main\n");
  assert.deepEqual(run("key"), first);

  execFileSync("git", ["add", "server/added.go"], { cwd: workspace });
  const added = run("key");
  assert.equal(added["module-hash"], first["module-hash"]);
  assert.notEqual(added["build-hash"], first["build-hash"]);
  assert.equal(added.prefix, first.prefix);
});

test("invalid commands and missing Go versions fail with a clear error", (context) => {
  const { workspace, env } = fixture(context);
  const invalid = spawnSync(process.execPath, [script, "unknown"], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage: go-cache.mjs version\|key/);

  writeFileSync(join(workspace, "server/go.mod"), "module example/server\n");
  const missing = spawnSync(process.execPath, [script, "version"], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No Go version in server\/go.mod/);
});
