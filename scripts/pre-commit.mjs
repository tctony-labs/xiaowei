import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function hash(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const before = new Map(staged.map((path) => [path, hash(path)]));

for (const recipe of ["fmt", "check"]) {
  const result = spawnSync("just", [recipe], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const changed = staged.filter((path) => hash(path) !== before.get(path));
if (changed.length > 0) {
  console.error("格式化修改了待提交文件，请检查改动并重新暂存后提交：");
  for (const path of changed) console.error(`  ${path}`);
  process.exit(1);
}
