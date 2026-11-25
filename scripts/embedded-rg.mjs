import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rgVersion = "15.2.0";

const archives = {
  arm64: {
    target: "aarch64-apple-darwin",
    digest: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  },
  x64: {
    target: "x86_64-apple-darwin",
    digest: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  },
};

const embeddedDirectory = fileURLToPath(new URL("../desktop/.embedded", import.meta.url));
export const embeddedBinDirectory = join(embeddedDirectory, "bin");
export const embeddedRgLicenses = join(embeddedDirectory, "rg-licenses");

const licenseFiles = ["LICENSE-MIT", "UNLICENSE"];

export function ensureEmbeddedRg() {
  const spec = process.platform === "darwin" ? archives[process.arch] : undefined;
  if (!spec) throw new Error("No embedded rg build for this platform and architecture");

  const binary = join(embeddedBinDirectory, "rg");
  const marker = join(embeddedDirectory, "rg.sha256");
  if (
    existsSync(marker) &&
    readFileSync(marker, "utf8") === spec.digest &&
    existsSync(binary) &&
    licenseFiles.every((name) => existsSync(join(embeddedRgLicenses, name)))
  ) {
    return embeddedBinDirectory;
  }

  mkdirSync(embeddedDirectory, { recursive: true });
  const staging = mkdtempSync(join(embeddedDirectory, ".rg-"));
  try {
    const name = `ripgrep-${rgVersion}-${spec.target}`;
    const archive = join(staging, `${name}.tar.gz`);
    const release = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "30",
        "--output",
        archive,
        `${release}/${name}.tar.gz`,
      ],
      { stdio: "inherit" },
    );

    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (digest !== spec.digest) throw new Error(`rg ${rgVersion} archive SHA-256 mismatch`);
    execFileSync("tar", ["-xf", archive, "-C", staging], { stdio: "inherit" });

    const extracted = join(staging, name);
    const executable = join(extracted, "rg");
    chmodSync(executable, 0o755);
    mkdirSync(embeddedBinDirectory, { recursive: true });
    mkdirSync(embeddedRgLicenses, { recursive: true });
    for (const license of licenseFiles) {
      renameSync(join(extracted, license), join(embeddedRgLicenses, license));
    }
    renameSync(executable, binary);
    const verified = join(staging, "rg.sha256");
    writeFileSync(verified, spec.digest);
    renameSync(verified, marker);
    console.info(`Embedded rg ${rgVersion} ready (${spec.target})`);
    return embeddedBinDirectory;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureEmbeddedRg();
}
