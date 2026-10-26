import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFixture } from "../../crates/xiaowei-mobile/ffi/scripts/binding-fixture.mjs";
import { run, targetDirectory } from "../../crates/xiaowei-mobile/ffi/scripts/ios-build.mjs";

const { values } = parseArgs({
  options: {
    destination: { type: "string" },
    "listen-host": { type: "string", default: "127.0.0.1" },
    "fixture-host": { type: "string", default: "127.0.0.1" },
    "public-only": { type: "boolean", default: false },
    team: { type: "string" },
  },
});
const destination = values.destination;
if (!destination) {
  throw new Error("Pass an explicit --destination for the intended iOS device");
}
const simulator = destination.split(",").some((part) => part === "platform=iOS Simulator");
if (!simulator && !destination.startsWith("platform=iOS,")) {
  throw new Error("Expected platform=iOS Simulator or platform=iOS");
}
const publicOnly = values["public-only"];
if (!simulator && !publicOnly && ["127.0.0.1", "localhost"].includes(values["fixture-host"])) {
  throw new Error("A physical device requires --fixture-host reachable from that device");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const runName = new Date().toISOString().replaceAll(":", "-");
const reportDirectory = join(root, "target/ios/runs", runName);
const derivedData = join(root, "target/ios", simulator ? "DerivedData" : "DeviceDerivedData");
await mkdir(reportDirectory, { recursive: true });

async function logged(command, arguments_, name, cwd = root) {
  console.log(`[ios] ${name}`);
  const path = join(reportDirectory, `${name}.log`);
  const output = createWriteStream(path);
  const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let forced;
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    forced = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, 600_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0 || result.signal) {
      throw new Error(`${name} failed; see ${path}`);
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(forced);
    await new Promise((resolve) => output.end(resolve));
  }
}

const revision = await run("git", ["rev-parse", "HEAD"]);
const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
const sourceHash = createHash("sha256").update(await run("git", ["diff", "HEAD"]));
const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
for (const name of untracked.split("\0").filter(Boolean)) {
  sourceHash.update(name).update(await readFile(join(root, name)));
}
const report = {
  revision,
  dirty: Boolean(status),
  sourceStateSha256: sourceHash.digest("hex"),
  platform: simulator ? "simulator" : "device",
  scope: publicOnly ? "public-https-and-lifecycle" : "isolated-network-and-public-https",
  destination,
  xcode: await run("xcodebuild", ["-version"]),
  sdk: await run("xcrun", [
    "--sdk",
    simulator ? "iphonesimulator" : "iphoneos",
    "--show-sdk-version",
  ]),
  scenarios: [],
  result: "running",
};
let ownedSimulator;

async function bootSimulator() {
  const selection = Object.fromEntries(destination.split(",").map((part) => part.split("=")));
  const [deviceList, runtimeList] = await Promise.all([
    run("xcrun", ["simctl", "list", "devices", "available", "--json"]),
    run("xcrun", ["simctl", "list", "runtimes", "--json"]),
  ]);
  const runtimes = JSON.parse(runtimeList).runtimes;
  const candidates = Object.entries(JSON.parse(deviceList).devices).flatMap(
    ([runtime, devices]) => {
      const version = runtimes.find((item) => item.identifier === runtime)?.version;
      return devices
        .filter((device) => {
          if (selection.id) return device.udid === selection.id;
          return device.name === selection.name && version === selection.OS;
        })
        .map((device) => ({ ...device, version }));
    },
  );
  assert.equal(candidates.length, 1, "Select one simulator by id or exact name and OS version");
  const device = candidates[0];
  report.device = { model: device.name, osVersion: device.version };
  if (device.state !== "Booted") {
    await run("xcrun", ["simctl", "boot", device.udid]);
    ownedSimulator = device.udid;
  }
  await logged("xcrun", ["simctl", "bootstatus", device.udid, "-b"], "simulator-ready");
}

try {
  if (!simulator) {
    const selection = Object.fromEntries(destination.split(",").map((part) => part.split("=")));
    assert.ok(selection.id, "Select a physical device by its discovered id");
    const detailsPath = join(reportDirectory, "device.json");
    await logged(
      "xcrun",
      [
        "devicectl",
        "device",
        "info",
        "details",
        "--device",
        selection.id,
        "--json-output",
        detailsPath,
      ],
      "device-details",
    );
    const details = JSON.parse(await readFile(detailsPath, "utf8")).result;
    report.device = {
      model: details.hardwareProperties.marketingName,
      osVersion: details.deviceProperties.osVersionNumber,
    };
    await rm(detailsPath);
  }
  await logged(process.execPath, ["ios/scripts/prepare.mjs"], "prepare");
  const buildArguments = [
    "-project",
    "ios/XiaoWei.xcodeproj",
    "-scheme",
    "XiaoWei",
    "-configuration",
    "Debug",
    "-destination",
    destination,
    "-derivedDataPath",
    derivedData,
    "-parallel-testing-enabled",
    "NO",
  ];
  if (simulator) buildArguments.push("CODE_SIGNING_ALLOWED=NO");
  else buildArguments.push("-allowProvisioningUpdates");
  if (values.team) buildArguments.push(`DEVELOPMENT_TEAM=${values.team}`);
  await logged("xcodebuild", [...buildArguments, "build-for-testing"], "build-for-testing");

  const products = join(derivedData, "Build/Products");
  const sdk = simulator ? "iphonesimulator" : "iphoneos";
  const runs = (await readdir(products)).filter(
    (name) => name.startsWith(`XiaoWei_${sdk}`) && name.endsWith(".xctestrun"),
  );
  assert.equal(runs.length, 1, "Expected one freshly built XCTest manifest for the platform");
  const original = JSON.parse(
    await run("plutil", ["-convert", "json", "-o", "-", join(products, runs[0])]),
  );
  const target = await targetDirectory();
  const binary = join(target, "mobile-bindings/ios-go-fixture");
  if (!publicOnly) {
    await mkdir(join(target, "mobile-bindings"), { recursive: true });
    await logged(
      "go",
      ["build", "-race", "-o", binary, "./internal/httpapi/ws/testfixture"],
      "build-fixture",
      join(root, "server"),
    );
  }

  if (simulator) await bootSimulator();

  const scenarios = publicOnly
    ? [
        ["public-ui", "XiaoWeiUITests/AppLaunchTests/testPublicServerAndLifecycle", 1],
        ["public-runtime", "XiaoWeiTests/MobileRuntimeTests/testPublicHttpsUsesRust", 1],
      ]
    : [
        ["ui", "XiaoWeiUITests/AppLaunchTests/testForegroundNetworkAndShutdown", 1],
        ["runtime", "XiaoWeiTests", 2],
      ];
  for (const [kind, testTarget, testCount] of scenarios) {
    let fixture;
    if (!publicOnly) {
      const now = Date.now();
      const samples = JSON.parse(
        await run("cargo", [
          "run",
          "--quiet",
          "--locked",
          "-p",
          "xiaowei-mobile",
          "--example",
          "binding-fixtures",
          "--",
          String(now),
        ]),
      );
      fixture = await createFixture(binary, now, samples.business_code, {
        samples,
        listenHost: values["listen-host"],
        advertisedHost: values["fixture-host"],
      });
    }
    const identifier = randomUUID();
    const manifest = join(products, `Runtime-${identifier}.xctestrun`);
    const json = join(products, `Runtime-${identifier}.json`);
    try {
      const configured = structuredClone(original);
      if (fixture) {
        for (const test of Object.values(configured).filter((value) => value.TestBundlePath)) {
          test.EnvironmentVariables = {
            ...test.EnvironmentVariables,
            XIAOWEI_FIXTURE_CONTROL_URL: fixture.controlUrl,
          };
        }
      }
      await writeFile(json, JSON.stringify(configured));
      await run("plutil", ["-convert", "xml1", "-o", manifest, json]);
      await logged(
        "xcodebuild",
        [
          "-xctestrun",
          manifest,
          "-destination",
          destination,
          "-parallel-testing-enabled",
          "NO",
          `-only-testing:${testTarget}`,
          "-resultBundlePath",
          join(reportDirectory, `${kind}.xcresult`),
          "-test-timeouts-enabled",
          "YES",
          "-default-test-execution-time-allowance",
          "75",
          "-maximum-test-execution-time-allowance",
          "90",
          "test-without-building",
        ],
        `test-${kind}`,
      );
      const summary = JSON.parse(
        await run("xcrun", [
          "xcresulttool",
          "get",
          "test-results",
          "summary",
          "--path",
          join(reportDirectory, `${kind}.xcresult`),
          "--compact",
        ]),
      );
      assert.equal(summary.passedTests, testCount, "XCTest did not execute all expected tests");
      assert.equal(summary.totalTestCount, testCount);
      assert.equal(summary.failedTests, 0);
      assert.equal(summary.skippedTests, 0);
      if (fixture) {
        assert.ok(fixture.summary().completed, "XCTest did not complete its fixture assertions");
      }
      report.scenarios.push({
        kind,
        result: "passed",
        passedTests: summary.passedTests,
        ...(fixture ? await fixture.assertComplete(kind) : {}),
      });
    } catch (error) {
      report.scenarios.push({ kind, result: "failed", ...fixture?.summary() });
      throw error;
    } finally {
      await rm(manifest, { force: true });
      await rm(json, { force: true });
      await fixture?.close();
    }
  }
  report.result = "passed";
  console.log(`[ios] App runtime verification passed: ${reportDirectory}`);
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  console.error(`[ios] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (ownedSimulator) {
    try {
      await run("xcrun", ["simctl", "shutdown", ownedSimulator]);
    } catch (error) {
      report.result = "failed";
      report.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  await writeFile(join(reportDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
