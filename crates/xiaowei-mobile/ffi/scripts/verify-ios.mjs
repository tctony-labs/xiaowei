import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

async function run(command, arguments_, env = process.env) {
  const result = await execute(command, arguments_, {
    cwd: root,
    env,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

const metadata = JSON.parse(await run("cargo", ["metadata", "--format-version", "1", "--no-deps"]));
const targetDirectory = metadata.target_directory;
const generated = join(targetDirectory, "mobile-bindings/ios-generated");
await mkdir(generated, { recursive: true });
await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--features", "bindgen"]);
await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--lib"]);
await run(join(targetDirectory, "debug/generate-mobile-bindings"), [
  "generate",
  join(targetDirectory, "debug/libxiaowei_mobile_ffi.dylib"),
  "--language",
  "swift",
  "--out-dir",
  generated,
  "--no-format",
]);

// A library verification target; the eventual application's deployment policy is separate.
const deploymentTarget = "15.0";
for (const [sdk, triple, target] of [
  ["iphoneos", `arm64-apple-ios${deploymentTarget}`, "aarch64-apple-ios"],
  ["iphonesimulator", `arm64-apple-ios${deploymentTarget}-simulator`, "aarch64-apple-ios-sim"],
]) {
  const sdkPath = await run("xcrun", ["--sdk", sdk, "--show-sdk-path"]);
  const env = {
    ...process.env,
    SDKROOT: sdkPath,
    IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
  };
  await run(
    "cargo",
    ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--lib", "--target", target],
    env,
  );
  const output = join(targetDirectory, target, "mobile-swift");
  await mkdir(output, { recursive: true });
  await run(
    "swiftc",
    [
      "-sdk",
      sdkPath,
      "-target",
      triple,
      "-swift-version",
      "6",
      "-strict-concurrency=complete",
      "-warnings-as-errors",
      "-parse-as-library",
      "-I",
      generated,
      "-Xcc",
      `-fmodule-map-file=${join(generated, "XiaoweiMobileFFI.modulemap")}`,
      "-emit-module",
      "-emit-library",
      "-module-name",
      "XiaoweiMobile",
      "-emit-module-path",
      join(output, "XiaoweiMobile.swiftmodule"),
      join(generated, "XiaoweiMobile.swift"),
      join(targetDirectory, target, "debug/libxiaowei_mobile_ffi.a"),
      "-framework",
      "Security",
      "-framework",
      "SystemConfiguration",
      "-Xlinker",
      "-fatal_warnings",
      "-o",
      join(output, "libXiaoweiMobile.dylib"),
    ],
    env,
  );
  console.log(`${target}: Rust static library and Swift SDK compilation/link passed`);
}
