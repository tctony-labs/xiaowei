import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mobileDir = fileURLToPath(new URL("../../mobile/", import.meta.url));
const flutterArgs = ["flutter", "--suppress-analytics"];

function output(program, args, options) {
  return execFileSync(program, args, {
    cwd: mobileDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function run(program, args) {
  execFileSync(program, args, { cwd: mobileDir, stdio: "inherit" });
}

function flutterJson(args) {
  return JSON.parse(output("fvm", [...flutterArgs, ...args, "--machine"]));
}

function readTarget(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

async function selectTarget(options) {
  if (options.length === 0) throw new Error("没有找到可用设备，请先连接真机或创建模拟器。");

  for (const [index, { id, name }] of options.entries()) {
    console.error(`${index + 1}. ${name} (${id})`);
  }

  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => {
      prompt.once("close", () => resolve(""));
      prompt.question("选择设备编号：", resolve);
    });
    const selected = options[Number(answer.trim()) - 1];
    if (!selected) throw new Error("未选中设备。");
    return selected.id;
  } finally {
    prompt.close();
  }
}

function connectedDevices(platform) {
  return flutterJson(["devices", "--device-timeout=5"]).filter(
    ({ targetPlatform, isSupported }) =>
      isSupported &&
      (platform === "ios" ? targetPlatform === "ios" : targetPlatform.startsWith("android-")),
  );
}

function iosSimulators() {
  const { devices } = JSON.parse(
    output("xcrun", ["simctl", "list", "devices", "available", "--json"]),
  );
  return Object.entries(devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([runtime, simulators]) => {
      const version = runtime.split(".iOS-").at(-1).replaceAll("-", ".");
      return simulators.map(({ udid, name }) => ({ id: udid, name: `${name} · iOS ${version}` }));
    });
}

function androidAdb() {
  const config = flutterJson(["config"]);
  const defaultSdk =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Android", "sdk")
      : join(homedir(), "Android", "Sdk");
  const sdk =
    config["android-sdk"] ?? process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? defaultSdk;
  for (const directory of [sdk, join(sdk, "sdk")]) {
    const adb = join(directory, "platform-tools", "adb");
    if (existsSync(adb)) return adb;
  }
  throw new Error(
    `Android SDK 缺少 Platform-Tools：${sdk}。请通过 Android Studio 的 SDK Manager 安装。`,
  );
}

function androidEmulators(adb) {
  const emulator = join(dirname(adb), "..", "emulator", "emulator");
  if (!existsSync(emulator)) return [];
  return output(emulator, ["-list-avds"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((id) => ({ id, name: `Android 模拟器 ${id}` }));
}

function runningAvd(adb, name) {
  const devices = output(adb, ["devices"]).split("\n");
  for (const line of devices) {
    const serial = /^(emulator-\d+)\s+device\s*$/.exec(line)?.[1];
    if (!serial) continue;

    try {
      const avdName = output(adb, ["-s", serial, "emu", "avd", "name"], { timeout: 3000 }).split(
        /\r?\n/,
        1,
      )[0];
      if (avdName === name) return serial;
    } catch {
      // A running emulator can disappear between discovery and reading its AVD name.
    }
  }
}

async function startAndroidEmulator(adb, name) {
  if (!runningAvd(adb, name)) run("fvm", [...flutterArgs, "emulators", "--launch", name]);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const serial = runningAvd(adb, name);
    if (
      serial &&
      output(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 5000 }) ===
        "1"
    ) {
      return serial;
    }
    await delay(1000);
  }
  throw new Error(`Android 模拟器 ${name} 未在两分钟内启动完成。`);
}

async function main([platform, argument = "", ...extra]) {
  if (!["ios", "android"].includes(platform) || extra.length > 0) {
    throw new Error("用法：just ios [设备 ID | -s] 或 just android [设备 ID、AVD 名称或 -s]");
  }

  const input = argument.trim();
  if (argument && (!input || /[\r\n]/.test(argument))) {
    throw new Error("设备 ID 必须为非空单行文本。");
  }

  const reselect = input === "-s";
  const targetFile = join(mobileDir, `.${platform}-device-id`);
  let target = reselect ? "" : input || readTarget(targetFile);
  if (!target && !process.stdin.isTTY) {
    const reason = reselect
      ? "重新选择设备需要交互终端"
      : `没有保存 ${platform} 设备 ID，当前终端无法交互`;
    throw new Error(`${reason}。请运行 just ${platform} <设备 ID>。`);
  }
  if (input && !reselect) writeFileSync(targetFile, `${target}\n`);

  run("fvm", ["install", "--skip-pub-get"]);
  const adb = platform === "android" ? androidAdb() : null;
  const connected = connectedDevices(platform);
  const matchesTarget = ({ id }) =>
    platform === "ios" ? id.toLowerCase() === target.toLowerCase() : id === target;
  let device = connected.find(matchesTarget)?.id;

  if (!device) {
    const simulators = platform === "ios" ? iosSimulators() : androidEmulators(adb);

    if (!target) {
      const options = new Map([...connected, ...simulators].map((item) => [item.id, item]));
      target = await selectTarget([...options.values()]);
      writeFileSync(targetFile, `${target}\n`);
      device = connected.find(matchesTarget)?.id;
    }

    const simulator = simulators.find(matchesTarget);
    if (!device && simulator) {
      if (platform === "ios") {
        run("xcrun", ["simctl", "bootstatus", simulator.id, "-b"]);
        run("open", ["-a", "Simulator"]);
        device = simulator.id;
      } else {
        device = await startAndroidEmulator(adb, simulator.id);
      }
    }
  }

  if (!device) {
    throw new Error(
      `未找到 ${platform} 设备 ${target}。请连接设备，或运行 just ${platform} -s 重新选择。`,
    );
  }

  run("fvm", [...flutterArgs, "run", "-d", device]);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status || 1;
}
