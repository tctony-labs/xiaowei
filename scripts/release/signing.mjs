import { spawnSync } from "node:child_process";
import { run } from "./sparkle.mjs";

export function signingConfiguration(env = process.env) {
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "APPLE_ID",
    "APPLE_TEAM_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
  ]) {
    if (!env[name]) throw new Error(`${name} is required for signed macOS packaging`);
  }
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error("APPLE_TEAM_ID must be a 10-character Team ID");
  const prefix = "Developer ID Application: ";
  if (!env.CSC_NAME.startsWith(prefix) || !env.CSC_NAME.endsWith(`(${env.APPLE_TEAM_ID})`)) {
    throw new Error("CSC_NAME must be a Developer ID Application identity matching APPLE_TEAM_ID");
  }
  // electron-builder accepts the holder and Team ID as a qualifier, without Apple's certificate type prefix.
  return { team: env.APPLE_TEAM_ID, identity: env.CSC_NAME.slice(prefix.length) };
}

export function verifySigningDetails(details, team, hardenedRuntime = true) {
  const signedTeam = details.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const authority = details.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
  const flags = details.match(/^CodeDirectory .*?flags=0x([0-9a-f]+)\b/im)?.[1];
  if (signedTeam !== team || !authority?.endsWith(`(${team})`)) {
    throw new Error("Code signature does not match the expected Developer ID Application and Team ID");
  }
  if (hardenedRuntime && (!flags || (Number.parseInt(flags, 16) & 0x10000) === 0)) {
    throw new Error("Code signature does not enable hardened runtime");
  }
}

export function verifySignedCode(path, team, hardenedRuntime = true) {
  run("codesign", ["--verify", "--strict", path]);
  const result = spawnSync("codesign", ["--display", "--verbose=4", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot read code signature: ${path}`);
  try {
    verifySigningDetails(result.stderr, team, hardenedRuntime);
  } catch (error) {
    throw new Error(`${error.message}: ${path}`);
  }
}

export function runStapler(action, path) {
  const delays = [5000, 10000, 20000];
  for (let attempt = 0; ; attempt += 1) {
    const result = spawnSync("xcrun", ["stapler", action, path], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status === 0) {
      if (attempt > 0) console.info(`stapler ${action} recovered on attempt ${attempt + 1}: ${path}`);
      return;
    }

    // stapler uses EX_NOHOST (68) for CloudKit ticket-service failures.
    const delay = delays[attempt];
    if (result.status !== 68 || delay === undefined) {
      throw new Error(`stapler ${action} failed with status ${result.status}: ${path}`);
    }
    console.warn(`stapler ${action} failed with status 68; retry ${attempt + 1}/3 in ${delay / 1000}s: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
}

export function notarizeDmg(path, env = process.env) {
  const result = spawnSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      path,
      "--apple-id",
      env.APPLE_ID,
      "--password",
      env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      env.APPLE_TEAM_ID,
      "--wait",
      "--output-format",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.status !== 0) throw new Error("DMG notarization command failed");
  const submission = JSON.parse(result.stdout);
  if (submission.status !== "Accepted") throw new Error(`DMG notarization failed: ${submission.status}`);
  console.info(`DMG notarization accepted: submission=${submission.id}`);
  runStapler("staple", path);
  runStapler("validate", path);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", path]);
}
