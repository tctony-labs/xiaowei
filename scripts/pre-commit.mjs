import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

function run(command, args, options = {}) {
  console.log(`[pre-commit] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

function changedFiles(args) {
  return execFileSync("git", ["diff", "--name-only", "-z", ...args])
    .toString()
    .split("\0")
    .filter(Boolean);
}

function hash(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const staged = changedFiles(["--cached", "--diff-filter=ACMR"]);
const unstaged = new Set(changedFiles([]));
const partial = staged.filter((path) => unstaged.has(path));
if (partial.length > 0) {
  console.error("以下待提交文件还有未暂存改动，请先全部暂存或 stash 未暂存改动后提交：");
  for (const path of partial) console.error(`  ${path}`);
  process.exit(1);
}

const before = new Map(staged.map((path) => [path, hash(path)]));
// Proto outputs retain their generator's formatting; just check verifies generation drift.
const generatedRoots = ["contracts/rust/src/gen/", "contracts/ts/src/gen/", "contracts/go/gen/"];
const files = staged
  .filter(
    (path) => lstatSync(path).isFile() && !generatedRoots.some((root) => path.startsWith(root)),
  )
  .map((path) => `./${path}`);

if (files.length > 0) {
  run("pnpm", [
    "exec",
    "biome",
    "check",
    "--write",
    "--files-ignore-unknown=true",
    "--no-errors-on-unmatched",
    ...files,
  ]);
}

const rust = files.filter((path) => path.endsWith(".rs"));
if (rust.length > 0) {
  const metadata = execFileSync("cargo", [
    "metadata",
    "--no-deps",
    "--format-version",
    "1",
    "--locked",
  ]);
  const packages = JSON.parse(metadata).packages.sort(
    (a, b) => b.manifest_path.length - a.manifest_path.length,
  );
  for (const path of rust) {
    const pkg = packages.find((pkg) =>
      resolve(path).startsWith(`${dirname(pkg.manifest_path)}${sep}`),
    );
    if (!pkg) throw new Error(`Cannot determine Rust edition for ${path}`);

    // Formatting stdin avoids following mod declarations into unstaged files.
    const source = readFileSync(path);
    const formatted = run("rustfmt", ["--edition", pkg.edition, "--emit", "stdout"], {
      cwd: dirname(resolve(path)),
      input: source,
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (!source.equals(formatted)) writeFileSync(path, formatted);
  }
}

const go = files.filter((path) => path.endsWith(".go"));
if (go.length > 0) {
  run("gofmt", ["-w", ...go]);
}

const changed = staged.filter((path) => hash(path) !== before.get(path));
if (changed.length > 0) {
  console.error("格式化修改了待提交文件，请检查改动并重新暂存后提交：");
  for (const path of changed) console.error(`  ${path}`);
  process.exit(1);
}

run("just", ["check"]);
