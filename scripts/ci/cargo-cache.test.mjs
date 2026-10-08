import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const script = fileURLToPath(new URL("./cargo-cache.mjs", import.meta.url));

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-cargo-cache-"));
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "Cargo.toml"), '[package]\nname = "cargo-cache-fixture"\nversion = "0.1.0"\n');
  writeFileSync(join(workspace, "src/main.rs"), 'fn main() { println!("first"); }\n');
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["add", "Cargo.toml", "src/main.rs"], { cwd: workspace });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, CARGO_INCREMENTAL: "0", RUSTFLAGS: "", CARGO_ENCODED_RUSTFLAGS: "" };
  const run = (mode, overrides = {}) =>
    execFileSync(process.execPath, [script, mode], { cwd: workspace, env: { ...env, ...overrides }, encoding: "utf8" });
  return { directory, workspace, env, run };
}

test("a cold cache is allowed and timestamps restore only for unchanged tracked files", (context) => {
  const { workspace, run } = fixture(context);
  assert.match(run("restore"), /No Cargo input timestamps/);
  const unchanged = join(workspace, "Cargo.toml");
  const changed = join(workspace, "src/main.rs");
  const original = statSync(unchanged).mtimeMs;
  run("save");

  const later = (Date.now() + 10000) / 1000;
  utimesSync(unchanged, later, later);
  writeFileSync(changed, 'fn main() { println!("changed"); }\n');
  utimesSync(changed, later, later);
  const added = join(workspace, "src/added.rs");
  writeFileSync(added, "// new input\n");
  execFileSync("git", ["add", "src/added.rs"], { cwd: workspace });
  const addedTime = statSync(added).mtimeMs;
  const changedTime = statSync(changed).mtimeMs;

  assert.match(run("restore"), /1 unchanged, 2 changed or new/);
  assert.ok(Math.abs(statSync(unchanged).mtimeMs - original) < 1);
  assert.equal(statSync(changed).mtimeMs, changedTime);
  assert.equal(statSync(added).mtimeMs, addedTime);
});

test("Rust changes rotate snapshots, flags isolate fallbacks and renderer changes retain the key", (context) => {
  const { workspace, run } = fixture(context);
  const rust = join(workspace, "crates/example.rs");
  const renderer = join(workspace, "desktop/example.tsx");
  mkdirSync(join(workspace, "crates"));
  mkdirSync(join(workspace, "desktop"));
  writeFileSync(rust, "pub fn first() {}\n");
  writeFileSync(renderer, "// first\n");
  execFileSync("git", ["add", "crates", "desktop"], { cwd: workspace });
  const [first, prefix] = run("key").trim().split("\n");
  writeFileSync(renderer, "// second\n");
  assert.equal(run("key").trim().split("\n")[0], first);
  writeFileSync(rust, "pub fn second() {}\n");
  const [second, samePrefix] = run("key").trim().split("\n");
  assert.notEqual(second, first);
  assert.equal(samePrefix, prefix);
  assert.ok(second.slice("key=".length).startsWith(prefix.slice("restore-key=".length)));
  const [, differentPrefix] = run("key", { RUSTFLAGS: "-C opt-level=1" }).trim().split("\n");
  assert.notEqual(differentPrefix, prefix);
});

test("restored Cargo artifacts stay fresh after checkout but changed Rust source recompiles", (context) => {
  const { directory, workspace, env, run } = fixture(context);
  const buildEnv = { ...env, CARGO_TERM_COLOR: "always" };
  const build = () => {
    const result = spawnSync("cargo", ["build", "--offline", "--verbose"], {
      cwd: workspace,
      env: buildEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return stripVTControlCharacters(result.stderr);
  };
  assert.match(build(), /Compiling cargo-cache-fixture/);
  execFileSync("git", ["add", "Cargo.lock"], { cwd: workspace });
  run("save");
  const target = join(workspace, "target");
  const cached = join(directory, "cached-target");
  cpSync(target, cached, { recursive: true, preserveTimestamps: true });
  rmSync(target, { recursive: true });
  cpSync(cached, target, { recursive: true, preserveTimestamps: true });

  const later = (Date.now() + 10000) / 1000;
  for (const path of ["Cargo.toml", "Cargo.lock", "src/main.rs"]) {
    utimesSync(join(workspace, path), later, later);
  }
  run("restore");
  assert.match(build(), /Fresh cargo-cache-fixture/);

  const source = join(workspace, "src/main.rs");
  writeFileSync(source, 'fn main() { println!("second"); }\n');
  utimesSync(source, later, later);
  run("restore");
  assert.match(build(), /Compiling cargo-cache-fixture/);
  const binary = join(
    target,
    "debug",
    process.platform === "win32" ? "cargo-cache-fixture.exe" : "cargo-cache-fixture",
  );
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "second");
});

test("unsupported timestamp snapshots fail instead of changing source timestamps", (context) => {
  const { workspace, env, run } = fixture(context);
  run("save");
  const snapshot = join(workspace, "target/ci-input-timestamps.json");
  const entries = JSON.parse(readFileSync(snapshot, "utf8"));
  writeFileSync(snapshot, JSON.stringify({ ...entries, version: 0 }));
  const result = spawnSync(process.execPath, [script, "restore"], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported Cargo input timestamp snapshot/);
});
