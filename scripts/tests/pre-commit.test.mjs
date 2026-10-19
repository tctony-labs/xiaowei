import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hook = join(root, "scripts/pre-commit.mjs");

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-pre-commit-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  };
  const read = (path) => readFileSync(join(directory, path), "utf8");
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const env = { ...process.env, PATH: `${join(directory, "tools")}:${process.env.PATH}` };
  const run = () => spawnSync(process.execPath, [hook], { cwd: directory, env, encoding: "utf8" });

  // Use the installed formatter without letting pnpm install dependencies in the fixture.
  const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
  write(
    "tools/pnpm",
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

assert.deepEqual(process.argv.slice(2, 4), ["exec", "biome"]);
const result = spawnSync(process.execPath, [${JSON.stringify(biome)}, ...process.argv.slice(4)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(join(directory, "tools/pnpm"), 0o755);
  write(".gitignore", "tools/\ntarget/\n");
  write("package.json", '{"private": true}\n');
  write("biome.json", readFileSync(join(root, "biome.json"), "utf8"));
  write("justfile", "check:\n    @echo full-workspace-check\n    pnpm exec biome check .\n");
  write("Cargo.toml", '[workspace]\nmembers = ["legacy", "modern"]\nresolver = "2"\n');
  for (const [name, edition] of [
    ["legacy", "2021"],
    ["modern", "2024"],
  ]) {
    write(
      `${name}/Cargo.toml`,
      `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "${edition}"\n`,
    );
    write(`${name}/src/lib.rs`, "pub fn example() {}\n");
  }
  for (const name of ["server", "contracts/go"]) {
    write(`${name}/go.mod`, `module example/${name}\n\ngo 1.26.0\n`);
    write(`${name}/main.go`, "package example\n\nfunc Example() {}\n");
  }
  write("selected file.js", 'console.log("initial");\n');
  write("other.js", 'console.log("initial");\n');
  execFileSync("cargo", ["generate-lockfile", "--offline"], { cwd: directory });
  execFileSync("pnpm", ["exec", "biome", "check", "--write", "."], { cwd: directory, env });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  return { directory, env, write, read, git, run };
}

test("partial staging is rejected before any formatter runs, without changing the index or files", (context) => {
  const { write, read, git, run } = fixture(context);
  write("selected file.js", "console.log( 'staged' )\n");
  git("add", "selected file.js");
  write("selected file.js", "console.log( 'unstaged' )\n");
  const index = git("write-tree");
  const result = run();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /未暂存改动/);
  assert.match(result.stderr, /selected file\.js/);
  assert.doesNotMatch(result.stdout, /\[pre-commit\]|full-workspace-check/);
  assert.equal(read("selected file.js"), "console.log( 'unstaged' )\n");
  assert.equal(git("write-tree"), index);
});

test("formatting only changes staged files; after restaging, check covers the whole workspace", (context) => {
  const { write, read, git, run } = fixture(context);
  write("selected file.js", "console.log( 'staged' )\n");
  git("add", "selected file.js");
  write("other.js", "console.log( 'unstaged' )\n");
  const index = git("write-tree");
  const formatted = run();

  assert.equal(formatted.status, 1, formatted.stderr);
  assert.match(formatted.stderr, /重新暂存/);
  assert.match(formatted.stderr, /selected file\.js/);
  assert.equal(read("selected file.js"), 'console.log("staged");\n');
  assert.equal(read("other.js"), "console.log( 'unstaged' )\n");
  assert.equal(git("write-tree"), index);

  git("add", "selected file.js");
  const checked = run();
  assert.notEqual(checked.status, 0);
  assert.match(checked.stdout, /full-workspace-check/);
  assert.match(checked.stdout + checked.stderr, /other\.js/);
  assert.equal(read("other.js"), "console.log( 'unstaged' )\n");
});

test("Rust uses each package edition without following child modules; Go formats only staged files", (context) => {
  const { write, read, git, run } = fixture(context);
  for (const name of ["legacy", "modern"]) {
    write(`${name}/src/lib.rs`, "mod child;\npub async fn example( ) { }\n");
    git("add", `${name}/src/lib.rs`);
    write(`${name}/src/child.rs`, "pub fn child( ) { }\n");
  }
  write("server/main.go", "package example\nfunc Example( ) { }\n");
  git("add", "server/main.go");
  write("contracts/go/main.go", "package example\nfunc Example( ) { }\n");
  const index = git("write-tree");
  const result = run();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /重新暂存/);
  assert.match(result.stdout, /--edition 2021/);
  assert.match(result.stdout, /--edition 2024/);
  for (const name of ["legacy", "modern"]) {
    assert.equal(read(`${name}/src/lib.rs`), "mod child;\npub async fn example() {}\n");
    assert.equal(read(`${name}/src/child.rs`), "pub fn child( ) { }\n");
  }
  assert.equal(read("server/main.go"), "package example\n\nfunc Example() {}\n");
  assert.equal(read("contracts/go/main.go"), "package example\nfunc Example( ) { }\n");
  assert.equal(git("write-tree"), index);
});

test("proto generated files keep their original bytes and still run the workspace check", (context) => {
  const { write, read, git, run } = fixture(context);
  const generated = {
    "contracts/rust/src/gen/example.rs": "pub struct Generated {pub value:u32}\n",
    "contracts/ts/src/gen/example.ts": "export const generated={value:1}\n",
    "contracts/go/gen/example.pb.go": "package generated\nfunc Generated( ) { }\n",
  };
  for (const [path, contents] of Object.entries(generated)) {
    write(path, contents);
    git("add", path);
  }
  const index = git("write-tree");
  const result = run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /full-workspace-check/);
  assert.doesNotMatch(result.stdout, /\[pre-commit\] (pnpm|rustfmt|gofmt)/);
  for (const [path, contents] of Object.entries(generated)) {
    assert.equal(read(path), contents);
  }
  assert.equal(git("write-tree"), index);
});

test("renames, deletions and unsupported files are accepted; an empty staged set still runs check", (context) => {
  const { write, git, run } = fixture(context);
  git("mv", "selected file.js", "renamed file.js");
  git("rm", "other.js");
  write("notes.txt", "unformatted text\n");
  git("add", "notes.txt");
  const index = git("write-tree");
  const result = run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /full-workspace-check/);
  assert.equal(git("write-tree"), index);

  git("reset", "-q", "HEAD");
  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.doesNotMatch(empty.stdout, /\[pre-commit\] pnpm/);
  assert.match(empty.stdout, /full-workspace-check/);
});

test("formatter errors block the check and preserve the index", (context) => {
  const { write, git, run } = fixture(context);
  write("selected file.js", "const = ;\n");
  git("add", "selected file.js");
  const index = git("write-tree");
  const result = run();

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /full-workspace-check/);
  assert.equal(git("write-tree"), index);
});

test("the repository just format entry formats files across the workspace without staging them", (context) => {
  const { directory, env, write, read, git } = fixture(context);
  write("other.js", "console.log( 'unstaged' )\n");
  write("modern/src/lib.rs", "pub fn example( ) { }\n");
  write("server/main.go", "package example\nfunc Example( ) { }\n");
  write("contracts/go/main.go", "package example\nfunc Example( ) { }\n");
  const index = git("write-tree");
  const result = spawnSync(
    "just",
    ["--justfile", join(root, "justfile"), "--working-directory", directory, "format"],
    {
      env,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(read("other.js"), 'console.log("unstaged");\n');
  assert.equal(read("modern/src/lib.rs"), "pub fn example() {}\n");
  assert.equal(read("server/main.go"), "package example\n\nfunc Example() {}\n");
  assert.equal(read("contracts/go/main.go"), "package example\n\nfunc Example() {}\n");
  assert.equal(git("write-tree"), index);
});
