import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localUpdateAppId, localUpdateDirectory, localUpdateName, localUpdateOrigin } from "./local-update-config.mjs";
import { notarizeDmg, signingConfiguration, verifySignedCode } from "./signing.mjs";
import { desktopDirectory, ensureSparkle, feedUrl, publicKey, releaseVersion, run } from "./sparkle.mjs";

export function packageMac({ signed = false, directoryOnly = false, localVersion, key, build = true } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS packaging must run on an Apple Silicon Mac");
  }
  key = publicKey(key ?? process.env.SPARKLE_ED_PUBLIC_KEY);
  const pkg = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
  const version = releaseVersion(localVersion ?? pkg.version);
  const localTest = localVersion !== undefined;
  if (localTest && signed) throw new Error("Local update tests must not use Developer ID credentials");
  const signing = signed ? signingConfiguration() : undefined;
  const signingTeam = signing?.team;

  ensureSparkle();
  console.info(`Building macOS arm64 ${version}; signing=${signed ? "Developer ID and notarization" : "ad-hoc"}`);
  if (build) {
    run("pnpm", ["--filter", "./crates/*/napi", "--workspace-concurrency=1", "run", "build"], {
      cwd: join(desktopDirectory, ".."),
    });
    run("pnpm", ["build"]);
  }
  const builderEnv = {
    ...process.env,
    SPARKLE_ED_PUBLIC_KEY: key,
    XIAOWEI_MAC_SIGNED: signed ? "1" : "0",
    XIAOWEI_LOCAL_UPDATE_VERSION: localVersion ?? "",
    CSC_IDENTITY_AUTO_DISCOVERY: signed ? "true" : "false",
  };
  if (!signed) {
    for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME"]) delete builderEnv[name];
  }
  // Use the selected organization Apple ID credentials instead of an ambient API or Keychain profile.
  for (const name of [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ]) {
    delete builderEnv[name];
  }
  run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--config",
      localTest ? "electron-builder.mac-test.cjs" : "electron-builder.mac.cjs",
      "--mac",
      "--arm64",
      "--publish",
      "never",
      ...(directoryOnly ? ["--dir"] : []),
    ],
    { env: builderEnv },
  );

  const output = localTest ? join(localUpdateDirectory, version) : join(desktopDirectory, "dist");
  const name = localTest ? localUpdateName : "XiaoWei";
  const app = join(output, "mac-arm64", `${name}.app`);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const expectedInfo = {
    CFBundleIdentifier: localTest ? localUpdateAppId : "com.tctony.xiaowei",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    SUFeedURL: localTest ? `${localUpdateOrigin}/appcast.xml` : feedUrl,
    SUPublicEDKey: key,
    SURequireSignedFeed: "true",
    SUVerifyUpdateBeforeExtraction: "true",
  };
  for (const [key, expected] of Object.entries(expectedInfo)) {
    const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], {
      encoding: "utf8",
    });
    if (result.status !== 0 || result.stdout.trim() !== expected) throw new Error(`Packaged ${key} mismatch`);
  }
  const require = createRequire(import.meta.url);
  for (const name of ["xiaowei-agent", "xiaowei-search", "xiaowei-clipboard", "xiaowei-storage", "xiaowei-platform"]) {
    const binary = join(app, "Contents/Resources/app.asar.unpacked/node_modules", name, `${name}.darwin-arm64.node`);
    run("lipo", [binary, "-verify_arch", "arm64"]);
    if (signed) verifySignedCode(binary, signingTeam);
    const dependencies = spawnSync("otool", ["-l", binary], { encoding: "utf8" });
    if (dependencies.status !== 0) throw new Error(`Cannot inspect native dependencies: ${name}`);
    for (const command of dependencies.stdout.split("Load command ")) {
      // LC_ID_DYLIB names the addon itself; it is not a dependency to load from the build machine.
      if (!/cmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD|LOAD_UPWARD)_DYLIB\n/.test(command)) continue;
      const dependency = command.match(/\bname (.+?) \(offset \d+\)/)?.[1];
      if (dependency && !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")) {
        throw new Error(`Unexpected non-system native dependency in ${name}: ${dependency}`);
      }
    }
    const addon = require(binary);
    if (name === "xiaowei-platform" && typeof addon.SparkleUpdater !== "function") {
      throw new Error("Packaged platform addon does not export SparkleUpdater");
    }
    console.info(`Packaged native module loaded: ${name}`);
  }
  if (signed) {
    for (const code of [
      app,
      join(app, "Contents/Frameworks/Electron Framework.framework"),
      join(app, "Contents/Frameworks/Sparkle.framework"),
      join(app, "Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate"),
      join(app, "Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app"),
      join(app, "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc"),
      join(app, "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc"),
    ]) {
      verifySignedCode(code, signingTeam);
    }
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    if (!directoryOnly) {
      const dmg = join(output, `${name}-${version}-arm64.dmg`);
      verifySignedCode(dmg, signingTeam, false);
      notarizeDmg(dmg);
    }
    console.info(`Developer ID signatures, hardened runtime and notarization verified: team=${signingTeam}`);
  }
  console.info("Packaged app signature, version, update configuration and arm64 native modules verified");
  return { app, version, output, archive: join(output, `${name}-${version}-arm64.zip`) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--signed" && arg !== "--dir")) {
    throw new Error("Usage: package-mac.mjs [--signed] [--dir]");
  }
  packageMac({ signed: args.includes("--signed"), directoryOnly: args.includes("--dir") });
}
