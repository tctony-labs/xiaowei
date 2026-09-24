// Shared build transaction only; each consumer owns its test list and prerequisites.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const runPnpm = (args) => execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });

export function assertProduction(packages) {
  execFileSync(process.execPath, ["scripts/tests/assert-production.cjs", ...packages], {
    cwd: root,
    stdio: "inherit",
  });
}

export async function withRustNapiFixtures(packages, runTests, { run = runPnpm, verify = assertProduction } = {}) {
  const failures = [];
  try {
    for (const name of packages) {
      run([
        "--filter",
        `xiaowei-${name}`,
        "build:debug",
        "--features",
        "gateway-fixtures",
        "--output-dir",
        `../../../target/rust-napi-tests/${name}`,
      ]);
    }
    await runTests();
  } catch (error) {
    failures.push(error);
  } finally {
    // Attempt every restoration even if a build, test or earlier restoration failed.
    for (const name of packages) {
      try {
        run(["--filter", `xiaowei-${name}`, "build:debug"]);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      verify(packages);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "napi tests or artifact restoration failed");
}
