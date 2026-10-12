#!/usr/bin/env bash
set -euo pipefail
umask 077

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

node --input-type=module - "$script_directory" <<'JS'
import { constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scriptDirectory = process.argv[2];
const { ensureSparkle, run } = await import(pathToFileURL(join(scriptDirectory, "sparkle.mjs")));
const { deriveUpdatePublicKey, verifyUpdateKeyPair } =
  await import(pathToFileURL(join(scriptDirectory, "check-release.mjs")));
const output = "/tmp/xiaowei-sparkle-private-key.txt";

try {
  lstatSync(output);
  throw new Error(`Private key export already exists; back it up before removing it: ${output}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const generateKeys = join(ensureSparkle(), "bin/generate_keys");
const directory = mkdtempSync(join(tmpdir(), "xiaowei-sparkle-keys-"));

try {
  run(generateKeys, ["--account", "xiaowei"]);
  const exported = join(directory, "private-key.txt");
  run(generateKeys, ["--account", "xiaowei", "-x", exported]);

  const secret = readFileSync(exported, "utf8");
  const key = deriveUpdatePublicKey(secret);
  verifyUpdateKeyPair(key, secret);
  copyFileSync(exported, output, constants.COPYFILE_EXCL);

  console.info(`Verified Sparkle private key exported: ${output}`);
  console.info("Configure its contents as the xiaowei repository secret SPARKLE_PRIVATE_KEY");
  console.info(`SPARKLE_ED_PUBLIC_KEY=${key}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
JS
