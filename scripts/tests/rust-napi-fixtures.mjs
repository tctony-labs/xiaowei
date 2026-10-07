// Production and fixture addons have separate outputs; each consumer owns its test list.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const runPnpm = (args, env = process.env) => execFileSync("pnpm", args, { cwd: root, stdio: "inherit", env });

// Set only for workspace test children after both sets of addons have been built successfully.
export const rustNapiPrepared = process.env.XIAOWEI_TEST_NAPI_PREPARED === "1";

export function assertProduction(packages) {
  execFileSync(process.execPath, ["scripts/tests/assert-production.cjs", ...packages], {
    cwd: root,
    stdio: "inherit",
  });
}

function writeFixturePackage(name) {
  // The workspace is ESM, but napi generates CommonJS loaders for these addons.
  const path = new URL(`../../target/rust-napi-tests/${name}/package.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);
}

export async function withRustNapiFixtures(
  packages,
  runTests,
  {
    run = runPnpm,
    verify = assertProduction,
    writePackage = writeFixturePackage,
    prepared = rustNapiPrepared,
    productionPrepared = false,
  } = {},
) {
  const failures = [];
  try {
    if (!prepared && !productionPrepared) {
      for (const name of packages) {
        run(["--filter", `xiaowei-${name}`, "build:debug"]);
      }
    }
    verify(packages);

    if (prepared) {
      console.log(`Reusing prepared Rust napi fixtures: ${packages.join(", ")}`);
    } else {
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
        writePackage(name);
      }
    }

    await runTests();
  } catch (error) {
    failures.push(error);
  } finally {
    // Fixture builds never write package outputs; check production even after a failure.
    try {
      verify(packages);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "napi tests or production artifact checks failed");
}
