import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopDirectory = fileURLToPath(new URL("../../desktop/", import.meta.url));
export const sparkleVersion = "2.10.0";
export const sparkleDigest = "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c";
export const sparkleDirectory = join(desktopDirectory, ".sparkle", sparkleVersion);
export const releaseRepository = "tctony-labs/xiaowei";
export const feedUrl = `https://github.com/${releaseRepository}/releases/latest/download/appcast.xml`;

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: desktopDirectory, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

export function ensureSparkle() {
  const marker = join(sparkleDirectory, ".verified");
  if (existsSync(marker) && readFileSync(marker, "utf8") === sparkleDigest) return sparkleDirectory;

  const archive = join(desktopDirectory, ".sparkle", `Sparkle-${sparkleVersion}.tar.xz`);
  mkdirSync(sparkleDirectory, { recursive: true });
  if (!existsSync(archive)) {
    run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--output",
      archive,
      `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-${sparkleVersion}.tar.xz`,
    ]);
  }

  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== sparkleDigest)
    throw new Error("Sparkle archive SHA-256 mismatch; remove the cached archive and retry");
  run("tar", ["-xf", archive, "-C", sparkleDirectory]);
  writeFileSync(marker, sparkleDigest);
  console.info(`Sparkle ${sparkleVersion} extracted and SHA-256 verified`);
  return sparkleDirectory;
}

export function releaseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("macOS releases require a stable x.y.z version");
  }
  return value;
}

export function publicKey(value) {
  if (
    !value ||
    Buffer.from(value, "base64").length !== 32 ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error("SPARKLE_ED_PUBLIC_KEY must be a base64-encoded 32-byte Ed25519 public key");
  }
  return value;
}

export function normalizePrivateKey(value) {
  if (!value) throw new Error("SPARKLE_ED_PRIVATE_KEY is required");
  const encoded = value.trim();
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  const valid = [32, 96].includes(decoded.length) && decoded.toString("base64") === padded;
  decoded.fill(0);
  if (!valid)
    throw new Error(
      "SPARKLE_ED_PRIVATE_KEY must be an official Sparkle Base64 seed or legacy export",
    );
  return padded;
}

function verificationKey(key) {
  const publicDer = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKey(key), "base64"),
  ]);
  return createPublicKey({ key: publicDer, format: "der", type: "spki" });
}

export function verifySignedAppcast({ feed, key }) {
  // Match SPUExtractAppcastContent for the signature block emitted by the pinned official tools.
  const marker = Buffer.from("<!-- sparkle-signatures:\n");
  const start = feed.lastIndexOf(marker);
  const end = feed.indexOf(Buffer.from("-->"), start + marker.length);
  if (start < 0 || end < 0) throw new Error("Appcast is missing its Sparkle signature block");
  const block = feed.subarray(start + marker.length, end).toString();
  const signature = block.match(/^edSignature: (.+)$/m)?.[1];
  const length = block.match(/^length: (\d+)$/m)?.[1];
  if (!signature || Number(length) !== start)
    throw new Error("Appcast signature metadata is invalid");
  if (
    !verify(null, feed.subarray(0, start), verificationKey(key), Buffer.from(signature, "base64"))
  ) {
    throw new Error("Appcast signature does not match SPARKLE_ED_PUBLIC_KEY");
  }
}

export function verifyUpdateArchive({ xml, archive, key, version, url }) {
  // Parse the one enclosure emitted by the pinned official generator; feed signature verification runs separately.
  const enclosure = xml.match(/<enclosure\b[^>]*>/)?.[0];
  const signature = enclosure?.match(/\bsparkle:edSignature="([^"]+)"/)?.[1];
  const archiveUrl = enclosure?.match(/\burl="([^"]+)"/)?.[1];
  const length = enclosure?.match(/\blength="([^"]+)"/)?.[1];
  const archiveVersion = xml.match(/<sparkle:version>([^<]+)<\/sparkle:version>/)?.[1];
  if (
    !signature ||
    archiveUrl !== url ||
    Number(length) !== archive.length ||
    archiveVersion !== version
  ) {
    throw new Error("Generated appcast does not describe the expected signed update archive");
  }
  if (!verify(null, archive, verificationKey(key), Buffer.from(signature, "base64"))) {
    throw new Error("Update archive signature does not match SPARKLE_ED_PUBLIC_KEY");
  }
}
