import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import { nativeUuid, verifyNativeSymbols } from "./native-symbols.mjs";
import { desktopDirectory, releaseVersion, run } from "./sparkle.mjs";
import { nativePackages, verifyPackageContent } from "./verify-package-content.mjs";

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function electronSymbols(version, checksums) {
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  return ["dsym.tar.xz", "symbols.zip"].map((suffix) => {
    const name = `electron-v${version}-darwin-arm64-${suffix}`;
    const digest = checksums
      .split(/\r?\n/)
      .map((line) => line.match(/^([\da-f]{64})\s+\*?(.+)$/i))
      .find((match) => match?.[2] === name)?.[1];
    if (!digest) throw new Error(`Missing Electron symbol checksum: ${name}`);
    return { name, url: `${base}/${name}`, sha256: digest.toLowerCase() };
  });
}

export function verifySourceMap(path, code) {
  const map = JSON.parse(readFileSync(path, "utf8"));
  if (
    map.version !== 3 ||
    map.file !== basename(path, ".map") ||
    typeof map.mappings !== "string" ||
    !Array.isArray(map.sources) ||
    (map.sources.length > 0 && !map.mappings) ||
    map.sourcesContent?.length !== map.sources.length ||
    !map.sourcesContent.every((source) => typeof source === "string")
  ) {
    throw new Error(`Incomplete source map: ${path}`);
  }
  if (/sourceMappingURL=/.test(code.toString("utf8"))) {
    throw new Error(`Expected hidden source map: ${path}`);
  }
}

export function archiveDebugSymbols(app, desktop = desktopDirectory) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Debug symbol archives require macOS arm64");
  }
  app = resolve(app);
  verifyPackageContent(app);
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const version = releaseVersion(pkg.version);
  const packagedVersion = capture("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(app, "Contents/Info.plist"),
  ]).trim();
  if (packagedVersion !== version) throw new Error("Debug archive application version mismatch");

  const output = resolve(app, "../..");
  const name = `XiaoWei-${version}-arm64-debug-symbols`;
  const temporary = mkdtempSync(join(output, ".debug-symbols-"));
  const directory = join(temporary, name);
  mkdirSync(directory);
  const files = {};
  const root = resolve(desktop, "..");

  function write(path, content) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  try {
    const native = [];
    for (const addon of nativePackages) {
      const binaryName = `${addon}.darwin-arm64.node`;
      const binary = join(
        app,
        "Contents/Resources/app.asar.unpacked/node_modules",
        addon,
        binaryName,
      );
      const dsym = join(root, "crates", addon, "napi", `${binaryName}.dSYM`);
      const uuid = verifyNativeSymbols(binary, dsym, "arm64");
      write(`native/${binaryName}`, readFileSync(binary));
      cpSync(dsym, join(directory, "native", `${binaryName}.dSYM`), { recursive: true });
      native.push({ name: addon, uuid, binary: `native/${binaryName}` });
      console.info(`Packaged native dSYM matched: ${addon}; UUID=${uuid}`);
    }

    const asar = join(app, "Contents/Resources/app.asar");
    let maps = 0;
    for (const entry of listPackage(asar)) {
      const path = entry.replace(/^\//, "");
      if (!/^out\/.*\.(?:js|cjs)$/.test(path)) continue;
      const code = extractFile(asar, path);
      if (!code.equals(readFileSync(join(desktop, path)))) {
        throw new Error(`Packaged JS differs from source map build: ${path}`);
      }
      const map = join(desktop, `${path}.map`);
      verifySourceMap(map, code);
      write(`javascript/${path}`, code);
      write(`javascript/${path}.map`, readFileSync(map));
      maps += 1;
    }
    if (!maps) throw new Error("No packaged JavaScript source maps found");

    const electronVersion = pkg.devDependencies.electron;
    const base = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
    const checksumsUrl = `${base}/SHASUMS256.txt`;
    const checksums = capture("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "2",
      "--connect-timeout",
      "15",
      "--max-time",
      "60",
      checksumsUrl,
    ]);
    const symbols = electronSymbols(electronVersion, checksums);
    write("electron/SHASUMS256.txt", checksums);
    const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
    const frameworkVersion = capture("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleVersion",
      join(framework, "Resources/Info.plist"),
    ]).trim();
    if (frameworkVersion !== electronVersion) throw new Error("Packaged Electron version mismatch");

    // Command Line Tools can build the app without a full Xcode installation.
    const xcode = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" });
    const manifest = {
      version,
      platform: "darwin",
      architecture: "arm64",
      commit: capture("git", ["rev-parse", "HEAD"], root).trim(),
      workingTree: capture("git", ["status", "--porcelain"], root).trim(),
      toolchains: {
        rust: capture("rustc", ["-Vv"], root).trim(),
        xcode: xcode.status === 0 ? xcode.stdout.trim() : null,
        macosSdk: capture("xcrun", ["--show-sdk-version"]).trim(),
        node: process.version,
      },
      native,
      sourceMaps: maps,
      electron: {
        version: electronVersion,
        frameworkUuid: nativeUuid(join(framework, "Electron Framework"), "arm64"),
        checksumsUrl,
        symbols,
      },
    };
    const patch = capture("git", ["diff", "--binary", "HEAD"], root);
    if (patch) write("source.patch", patch);

    // Include dSYM bundle contents in the same checksum inventory as JS and binaries.
    function hashFiles(current, prefix = "") {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) hashFiles(join(current, entry.name), path);
        else files[path] = sha256(readFileSync(join(current, entry.name)));
      }
    }
    hashFiles(directory);
    manifest.files = files;
    writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = join(output, `${name}.zip`);
    const stagedArchive = join(temporary, `${name}.zip`);
    run("ditto", ["-c", "-k", "--keepParent", directory, stagedArchive]);
    renameSync(stagedArchive, archive);
    console.info(`Debug symbols archived: ${archive}; ${maps} source maps, two dSYMs`);
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: debug-symbols.mjs <packaged-app>");
  archiveDebugSymbols(process.argv[2]);
}
