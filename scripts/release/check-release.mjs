import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signingConfiguration } from "./signing.mjs";
import { desktopDirectory, ensureSparkle, normalizePrivateKey, publicKey, releaseVersion } from "./sparkle.mjs";

export function deriveUpdatePublicKey(secret) {
  const decoded = Buffer.from(normalizePrivateKey(secret), "base64");
  try {
    if (decoded.length === 96) return decoded.subarray(64).toString("base64");
    const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), decoded]);
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    privateDer.fill(0);
    return createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  } finally {
    decoded.fill(0);
  }
}

export function verifyUpdateKeyPair(key, secret) {
  publicKey(key);
  const encoded = normalizePrivateKey(secret);
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-key-check-"));
  try {
    const data = Buffer.from("XiaoWei release signing key validation\n");
    const path = join(directory, "challenge.txt");
    writeFileSync(path, data);
    const result = spawnSync(join(ensureSparkle(), "bin/sign_update"), ["--ed-key-file", "-", "-p", path], {
      input: `${encoded}\n`,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Sparkle could not sign with SPARKLE_ED_PRIVATE_KEY");
    const publicDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "base64")]);
    const verificationKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    if (!verify(null, data, verificationKey, Buffer.from(result.stdout.trim(), "base64"))) {
      throw new Error("SPARKLE_ED_PRIVATE_KEY does not match SPARKLE_ED_PUBLIC_KEY");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function checkRelease(tag, version, env = process.env) {
  if (tag !== `v${releaseVersion(version)}`) throw new Error("Release tag must match desktop/package.json version");
  const { team } = signingConfiguration(env);
  verifyUpdateKeyPair(env.SPARKLE_ED_PUBLIC_KEY, env.SPARKLE_ED_PRIVATE_KEY);
  return { tag, version, team };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: check-release.mjs v<version>");
  const { version } = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
  const release = checkRelease(process.argv[2], version);
  console.info(`Release inputs verified: ${release.tag}; expected signing team=${release.team}`);
}
