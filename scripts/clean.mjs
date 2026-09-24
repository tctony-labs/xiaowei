import { execFileSync } from "node:child_process";
import { existsSync, globSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const workspace = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const worktrees = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((field) => field.startsWith("worktree "))
  .map((field) => resolve(field.slice("worktree ".length)));

// Git lists the main worktree first. Linked worktrees only clean themselves.
const workspaces = [workspace];
if (workspace === worktrees[0]) {
  const prefix = join(workspace, "worktrees") + sep;
  workspaces.push(...worktrees.slice(1).filter((path) => path.startsWith(prefix)));
}

const outputs = [
  "target",
  "desktop/out",
  "desktop/dist",
  "desktop/storybook-static",
  "server/bin",
  "gateway/ts/dist",
  "gateway/tests/native",
];

const cleanups = workspaces.map((root) => ({
  root,
  paths: [...outputs, ...globSync("crates/*/napi/*.node", { cwd: root })]
    .map((output) => join(root, output))
    .filter(existsSync),
}));
const paths = cleanups.flatMap((cleanup) => cleanup.paths);

// Measure allocated blocks once across all workspaces, without reading file contents.
let totalBytes = 0;
if (paths.length > 0) {
  const usage = execFileSync("du", ["-skc", ...paths], { encoding: "utf8" });
  totalBytes = Number.parseInt(usage.trimEnd().split("\n").at(-1), 10) * 1024;
}

for (const cleanup of cleanups) {
  console.log(`Cleaning ${cleanup.root}`);
  for (const path of cleanup.paths) {
    rmSync(path, { recursive: true, force: true });
  }
}

const units = ["B", "KiB", "MiB", "GiB", "TiB"];
const unit = totalBytes === 0 ? 0 : Math.min(Math.floor(Math.log(totalBytes) / Math.log(1024)), units.length - 1);
console.log(`Cleaned ${(totalBytes / 1024 ** unit).toFixed(2)} ${units[unit]} (disk usage before cleanup)`);
