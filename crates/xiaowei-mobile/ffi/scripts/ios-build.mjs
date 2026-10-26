import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const root = fileURLToPath(new URL("../../../../", import.meta.url));

export async function run(command, arguments_, options = {}) {
  const result = await execute(command, arguments_, {
    cwd: root,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

export async function targetDirectory() {
  const metadata = await run("cargo", [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--no-deps",
  ]);
  return JSON.parse(metadata).target_directory;
}

export async function generateSwift(target, output) {
  await mkdir(output, { recursive: true });
  const env = { ...process.env };
  delete env.SDKROOT;
  delete env.IPHONEOS_DEPLOYMENT_TARGET;
  await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--features", "bindgen"], {
    env,
  });
  await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--lib"], { env });
  await run(
    join(target, "debug/generate-mobile-bindings"),
    [
      "generate",
      join(target, "debug/libxiaowei_mobile_ffi.dylib"),
      "--language",
      "swift",
      "--out-dir",
      output,
      "--no-format",
    ],
    { env },
  );
}

export async function buildTargets(target, deploymentTarget, configuration = "Debug") {
  if (!/^\d+\.\d+$/.test(deploymentTarget)) {
    throw new Error("Expected an iOS deployment version such as 17.0");
  }
  if (!["Debug", "Release"].includes(configuration)) {
    throw new Error("Configuration must be Debug or Release");
  }
  const profile = configuration.toLowerCase();
  // Cargo's incremental objects can retain a prior deployment version. Keep the
  // library check (15.0) and App builds (17.0) in distinct target directories.
  const cargoTarget = join(target, "mobile-ios-cargo", deploymentTarget);
  const results = [];
  for (const [sdk, suffix, rustTarget] of [
    ["iphoneos", "", "aarch64-apple-ios"],
    ["iphonesimulator", "-simulator", "aarch64-apple-ios-sim"],
  ]) {
    const sdkPath = await run("xcrun", ["--sdk", sdk, "--show-sdk-path"]);
    const env = {
      ...process.env,
      SDKROOT: sdkPath,
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
    };
    const arguments_ = [
      "build",
      "--locked",
      "-p",
      "xiaowei-mobile-ffi",
      "--lib",
      "--target",
      rustTarget,
      "--target-dir",
      cargoTarget,
    ];
    if (configuration === "Release") arguments_.push("--release");
    await run("cargo", arguments_, { env });
    results.push({
      sdkPath,
      rustTarget,
      swiftTarget: `arm64-apple-ios${deploymentTarget}${suffix}`,
      library: join(cargoTarget, rustTarget, profile, "libxiaowei_mobile_ffi.a"),
      env,
    });
  }
  return results;
}
