import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cache = join(root, "target/mobile-bindings/tools");

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function artifact(name, url, checksum) {
  const path = join(cache, name);
  async function valid() {
    if (!(await exists(path))) return false;
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === checksum;
  }
  if (await valid()) return path;
  const pending = `${path}.part`;
  try {
    await execute(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry",
        "2",
        "--connect-timeout",
        "15",
        "--max-time",
        "300",
        "--output",
        pending,
        url,
      ],
      { timeout: 330_000 },
    );
    const bytes = await readFile(pending);
    if (createHash("sha256").update(bytes).digest("hex") !== checksum) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
  return path;
}

export async function ensureTools() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This verification entry currently supports macOS arm64 hosts.");
  }
  await mkdir(cache, { recursive: true });
  const jdkName = "OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz";
  const kotlinName = "kotlin-compiler-2.1.20.zip";
  const maven = "https://repo.maven.apache.org/maven2";
  const [jdk, kotlin, jna, coroutines] = await Promise.all([
    artifact(
      jdkName,
      `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/${jdkName}`,
      "bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a",
    ),
    artifact(
      kotlinName,
      `https://github.com/JetBrains/kotlin/releases/download/v2.1.20/${kotlinName}`,
      "a118197b0de55ffab2bc8d5cd03a5e39033cfb53383d6931bc761dec0784891a",
    ),
    artifact(
      "jna-5.17.0.jar",
      `${maven}/net/java/dev/jna/jna/5.17.0/jna-5.17.0.jar`,
      "b3a9408e7c51e08ef0e3bfcc08f443f6ec0f6191ba8cd7c18d53d2b22e5bdbc0",
    ),
    artifact(
      "kotlinx-coroutines-core-jvm-1.10.2.jar",
      `${maven}/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.10.2/` +
        "kotlinx-coroutines-core-jvm-1.10.2.jar",
      "5ca175b38df331fd64155b35cd8cae1251fa9ee369709b36d42e0a288ccce3fd",
    ),
  ]);
  const javaHome = join(cache, "jdk-21.0.13+9/Contents/Home");
  if (!(await exists(join(javaHome, "bin/java")))) {
    await execute("tar", ["-xzf", jdk, "-C", cache], { timeout: 60_000 });
  }
  const kotlinc = join(cache, "kotlinc/bin/kotlinc");
  if (!(await exists(kotlinc))) {
    await execute("unzip", ["-q", "-o", kotlin, "-d", cache], { timeout: 60_000 });
  }
  return { javaHome, java: join(javaHome, "bin/java"), kotlinc, classpath: `${jna}:${coroutines}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tools = await ensureTools();
  console.log(`Mobile binding toolchain ready: ${tools.javaHome}`);
}
