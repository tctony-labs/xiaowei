import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopDirectory,
  ensureSparkle,
  normalizePrivateKey,
  publicKey,
  releaseRepository,
  releaseVersion,
  run,
  verifySignedAppcast,
  verifyUpdateArchive,
} from "./sparkle.mjs";

export function generateAppcast({
  archivePath,
  output,
  version,
  urlPrefix,
  key,
  privateKey,
  notesUrl,
}) {
  releaseVersion(version);
  if (!privateKey) throw new Error("SPARKLE_ED_PRIVATE_KEY is required to sign the appcast");
  publicKey(key);
  const sparkle = ensureSparkle();
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-appcast-"));
  const archive = basename(archivePath);
  try {
    copyFileSync(archivePath, join(directory, archive));
    // Sparkle reads the seed from stdin; it is never an argument or a persistent file.
    const input = `${normalizePrivateKey(privateKey)}\n`;
    run(
      join(sparkle, "bin/generate_appcast"),
      [
        "--ed-key-file",
        "-",
        "--download-url-prefix",
        urlPrefix,
        ...(notesUrl ? ["--full-release-notes-url", notesUrl] : []),
        "--maximum-versions",
        "1",
        "--maximum-deltas",
        "0",
        "-o",
        output,
        directory,
      ],
      { input, stdio: ["pipe", "inherit", "inherit"] },
    );
    run(join(sparkle, "bin/sign_update"), ["--verify", "--ed-key-file", "-", output], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    verifySignedAppcast({ feed: readFileSync(output), key });
    verifyUpdateArchive({
      xml: readFileSync(output, "utf8"),
      archive: readFileSync(archivePath),
      key,
      version,
      url: `${urlPrefix}${encodeURIComponent(archive)}`,
    });
    console.info(`Signed Sparkle appcast generated for ${version}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
  const version = releaseVersion(pkg.version);
  const tag = process.argv[2];
  if (process.argv.length !== 3 || tag !== `v${version}`) {
    throw new Error(`Expected release tag v${version} matching desktop/package.json`);
  }
  generateAppcast({
    archivePath: join(desktopDirectory, "dist", `XiaoWei-${version}-arm64.zip`),
    output: join(desktopDirectory, "dist/appcast.xml"),
    version,
    urlPrefix: `https://github.com/${releaseRepository}/releases/download/${tag}/`,
    notesUrl: `https://github.com/${releaseRepository}/releases/tag/${tag}`,
    key: process.env.SPARKLE_ED_PUBLIC_KEY,
    privateKey: process.env.SPARKLE_ED_PRIVATE_KEY,
  });
}
