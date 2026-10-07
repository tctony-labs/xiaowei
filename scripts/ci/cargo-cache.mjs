import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
if (!["key", "save", "restore"].includes(mode)) throw new Error("Usage: cargo-cache.mjs key|save|restore");

const workspace = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const snapshotPath = join(workspace, "target", "ci-input-timestamps.json");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: workspace, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .sort();
const files = tracked.filter((path) => {
  const absolute = join(workspace, path);
  return existsSync(absolute) && lstatSync(absolute).isFile();
});

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function fingerprint(path) {
  return hash(readFileSync(join(workspace, path)));
}

if (mode === "key") {
  const compiler = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
  const environment = hash(JSON.stringify([compiler, process.env.RUSTFLAGS, process.env.CARGO_ENCODED_RUSTFLAGS]));
  const inputs = files.filter(
    (path) =>
      /^(crates|contracts\/(rust|tools)|gateway\/rust|\.cargo)\//.test(path) ||
      [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "justfile",
        ".github/workflows/test.yml",
        "scripts/dev/build-napi.mjs",
        "scripts/tests/run.mjs",
        "scripts/tests/rust-napi-fixtures.mjs",
        "scripts/ci/cargo-cache.mjs",
      ].includes(path),
  );
  const sources = hash(JSON.stringify(inputs.map((path) => [path, fingerprint(path)])));
  const prefix = `cargo-v1-${process.platform}-${process.arch}-${environment}-`;
  console.log(`key=${prefix}${sources}`);
  console.log(`restore-key=${prefix}`);
} else if (mode === "save") {
  const entries = files.map((path) => ({
    path,
    hash: fingerprint(path),
    mtimeMs: lstatSync(join(workspace, path)).mtimeMs,
  }));
  mkdirSync(join(workspace, "target"), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({ version: 1, files: entries }));
  console.log(`Saved Cargo input timestamps: ${entries.length} tracked files`);
} else if (!existsSync(snapshotPath)) {
  console.log("No Cargo input timestamps to restore; preparing a new cache");
} else {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (snapshot.version !== 1) throw new Error("Unsupported Cargo input timestamp snapshot");
  const previous = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  let restored = 0;
  let changed = 0;
  for (const path of files) {
    const entry = previous.get(path);
    if (!entry || fingerprint(path) !== entry.hash) {
      changed++;
      continue;
    }
    const absolute = join(workspace, path);
    utimesSync(absolute, lstatSync(absolute).atime, entry.mtimeMs / 1000);
    restored++;
  }
  console.log(`Restored Cargo input timestamps: ${restored} unchanged, ${changed} changed or new`);
}
