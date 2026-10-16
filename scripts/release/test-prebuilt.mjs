import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, runPnpm, withRustNapiFixtures } from "../tests/rust-napi-fixtures.mjs";

export function nativeHashes(directory = root) {
  return ["agent", "platform", "search", "storage", "clipboard"].map((name) => {
    const binary = join(
      directory,
      "crates",
      `xiaowei-${name}`,
      "napi",
      `xiaowei-${name}.darwin-arm64.node`,
    );
    return createHash("sha256").update(readFileSync(binary)).digest("hex");
  });
}

// Release CI has already built production addons. Only fixtures need a separate build.
export async function testPrebuilt({
  run = runPnpm,
  fixtures = withRustNapiFixtures,
  hashes = nativeHashes,
} = {}) {
  const before = hashes();
  const failures = [];
  try {
    run(["check"]);
    run([
      "exec",
      "node",
      "--test",
      "scripts/dev/build-napi.test.mjs",
      "scripts/dev/desktop-source-resolution.test.mjs",
      "scripts/tests/package-content.test.mjs",
      "scripts/tests/macos-release.test.mjs",
      "scripts/tests/release-prebuilt.test.mjs",
      "scripts/tests/rust-napi-fixtures.test.mjs",
    ]);
    await fixtures(
      ["search"],
      () => {
        const env = { ...process.env, XIAOWEI_TEST_NAPI_PREPARED: "1" };
        run(["--filter", "xiaowei-platform", "test"], env);
        run(["--dir", "desktop", "test"], env);
      },
      { prepared: false, productionPrepared: true },
    );
  } catch (error) {
    failures.push(error);
  }

  try {
    const after = hashes();
    if (before.some((hash, index) => hash !== after[index])) {
      throw new Error("Production release addons changed during tests; refusing to package");
    }
    console.info("Five production release addon SHA-256 hashes unchanged after tests");
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Release tests or addon integrity checks failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testPrebuilt();
}
