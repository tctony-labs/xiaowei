import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { generateAppcast } from "./generate-appcast.mjs";
import { localUpdateDirectory, localUpdateName, localUpdateOrigin } from "./local-update-config.mjs";
import { packageMac } from "./package-mac.mjs";
import { desktopDirectory, releaseVersion } from "./sparkle.mjs";

if (process.argv.length !== 2) throw new Error("Usage: local-update.mjs");
if (existsSync(join(localUpdateDirectory, "test.json"))) {
  throw new Error(
    "Local fixtures already exist; move desktop/dist/local-update aside before preparing a new test pair",
  );
}
const { version } = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
const oldVersion = releaseVersion(version);
const [major, minor, patch] = oldVersion.split(".");
const newVersion = `${major}.${minor}.${BigInt(patch) + 1n}`;
const keys = generateKeyPairSync("ed25519");
const key = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const seed = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);

try {
  const oldPackage = packageMac({ localVersion: oldVersion, key });
  // Only the bundle and package versions differ; reuse the exact release addons and desktop build.
  const newPackage = packageMac({ localVersion: newVersion, key, build: false });
  const source = join(localUpdateDirectory, "source");
  mkdirSync(source, { recursive: true });
  const archive = basename(newPackage.archive);
  copyFileSync(newPackage.archive, join(source, archive));
  generateAppcast({
    archivePath: join(source, archive),
    output: join(source, "appcast.xml"),
    version: newVersion,
    urlPrefix: `${localUpdateOrigin}/`,
    key,
    privateKey: seed.toString("base64"),
  });
  const installedApp = join(localUpdateDirectory, "installed", `${localUpdateName}.app`);
  cpSync(oldPackage.app, installedApp, { recursive: true, verbatimSymlinks: true });
  const manifest = {
    oldVersion,
    newVersion,
    key,
    archive,
    oldApp: oldPackage.app,
    newApp: newPackage.app,
    installedApp,
  };
  writeFileSync(join(localUpdateDirectory, "test.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(`Local test packages ready: ${oldVersion} -> ${newVersion}`);
  console.info("Start the update source: pnpm --dir desktop update:mac:serve");
  console.info(`Launch the installed test app yourself: ${installedApp}`);
  console.info("These isolated ad-hoc packages use a temporary test key and must not be publicly distributed");
} finally {
  seed.fill(0);
}
