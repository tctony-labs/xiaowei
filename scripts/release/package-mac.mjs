import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localUpdateAppId,
  localUpdateDirectory,
  localUpdateName,
  localUpdateOrigin,
} from "./local-update-config.mjs";
import {
  notarizeApp,
  notarizeDmg,
  runStapler,
  signingConfiguration,
  verifySignedCode,
} from "./signing.mjs";
import {
  desktopDirectory,
  ensureSparkle,
  feedUrl,
  publicKey,
  releaseVersion,
  run,
} from "./sparkle.mjs";

export function packageMac({
  signed = false,
  directoryOnly = false,
  localVersion,
  key,
  build = true,
  stage = "all",
} = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS packaging must run on an Apple Silicon Mac");
  }
  if (!["all", "app", "dmg", "notarize", "zip"].includes(stage))
    throw new Error(`Unknown packaging stage: ${stage}`);
  if (stage === "notarize" && !signed) throw new Error("Notarization requires signed packaging");
  if (stage !== "all" && directoryOnly)
    throw new Error("directoryOnly cannot be combined with a packaging stage");

  key = publicKey(key ?? process.env.SPARKLE_ED_PUBLIC_KEY);
  const pkg = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
  const version = releaseVersion(localVersion ?? pkg.version);
  const localTest = localVersion !== undefined;
  if (localTest && signed)
    throw new Error("Local update tests must not use Developer ID credentials");
  let steps = ["app"];
  if (!directoryOnly) steps = ["app", "dmg", ...(signed ? ["notarize"] : []), "zip"];
  if (stage !== "all") steps = [stage];
  if (signed && (steps.includes("app") || steps.includes("dmg"))) signingConfiguration();
  const signingTeam = signed ? process.env.APPLE_TEAM_ID : undefined;
  const output = localTest ? join(localUpdateDirectory, version) : join(desktopDirectory, "dist");
  const name = localTest ? localUpdateName : "XiaoWei";
  const app = join(output, "mac-arm64", `${name}.app`);
  const dmg = join(output, `${name}-${version}-arm64.dmg`);
  const archive = join(output, `${name}-${version}-arm64.zip`);
  const verification = { app, version, key, localTest, signed, signingTeam };

  if (steps.includes("app")) {
    ensureSparkle();
    if (build) {
      run("pnpm", ["--filter", "./crates/*/napi", "--workspace-concurrency=1", "run", "build"], {
        cwd: join(desktopDirectory, ".."),
      });
      run("pnpm", ["build"]);
    }
  } else {
    verifyPackagedApp(verification);
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
  // Use explicit Apple ID credentials only in our single notarization submission.
  for (const name of [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ]) {
    delete builderEnv[name];
  }

  for (const step of steps) {
    console.info(`macOS arm64 ${version}: ${step}; signing=${signed ? "Developer ID" : "ad-hoc"}`);
    if (step === "notarize") {
      verifySignedCode(dmg, signingTeam, false);
      notarizeDmg(dmg, app);
      console.info("macOS packaging stage complete: notarize");
      continue;
    }
    if (step === "zip" && signed) {
      // A separate CI step must never archive an app without its notarization ticket.
      runStapler("validate", app);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    }

    if (step === "zip") {
      // Archive the stapled app directly; do not rebuild or re-sign either distribution artifact.
      run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
    } else {
      run(
        "pnpm",
        [
          "exec",
          "electron-builder",
          "--config",
          localTest ? "electron-builder.mac-test.cjs" : "electron-builder.mac.cjs",
          "--mac",
          ...(step === "dmg" ? ["dmg"] : []),
          "--arm64",
          "--publish",
          "never",
          ...(step === "app" ? ["--dir"] : ["--prepackaged", app]),
        ],
        { env: builderEnv },
      );
    }

    if (step === "app") verifyPackagedApp(verification);
    if (step === "dmg" && signed) verifySignedCode(dmg, signingTeam, false);
    console.info(`macOS packaging stage complete: ${step}`);
  }

  // Directory-only packaging has no DMG; submit the app once via a temporary ZIP.
  if (directoryOnly && signed) notarizeApp(app);
  return { app, version, output, archive, dmg };
}

function verifyPackagedApp({ app, version, key, localTest, signed, signingTeam }) {
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
    const result = spawnSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, join(app, "Contents/Info.plist")],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0 || result.stdout.trim() !== expected)
      throw new Error(`Packaged ${key} mismatch`);
  }
  const require = createRequire(import.meta.url);
  for (const name of [
    "xiaowei-agent",
    "xiaowei-search",
    "xiaowei-clipboard",
    "xiaowei-storage",
    "xiaowei-platform",
  ]) {
    const binary = join(
      app,
      "Contents/Resources/app.asar.unpacked/node_modules",
      name,
      `${name}.darwin-arm64.node`,
    );
    run("lipo", [binary, "-verify_arch", "arm64"]);
    if (signed) verifySignedCode(binary, signingTeam);
    const dependencies = spawnSync("otool", ["-l", binary], { encoding: "utf8" });
    if (dependencies.status !== 0) throw new Error(`Cannot inspect native dependencies: ${name}`);
    for (const command of dependencies.stdout.split("Load command ")) {
      // LC_ID_DYLIB names the addon itself; it is not a dependency to load from the build machine.
      if (!/cmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD|LOAD_UPWARD)_DYLIB\n/.test(command))
        continue;
      const dependency = command.match(/\bname (.+?) \(offset \d+\)/)?.[1];
      if (
        dependency &&
        !dependency.startsWith("/usr/lib/") &&
        !dependency.startsWith("/System/Library/")
      ) {
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
    console.info(`Developer ID signatures and hardened runtime verified: team=${signingTeam}`);
  }
  console.info(
    "Packaged app signature, version, update configuration and arm64 native modules verified",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--signed" && arg !== "--dir")) {
    throw new Error("Usage: package-mac.mjs [--signed] [--dir]");
  }
  packageMac({ signed: args.includes("--signed"), directoryOnly: args.includes("--dir") });
}
