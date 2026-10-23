import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadDeltaBaselines, maximumDeltas } from "./delta-baselines.mjs";
import { readReleaseNotes } from "./release-notes.mjs";
import {
  desktopDirectory,
  ensureSparkle,
  normalizePrivateKey,
  publicKey,
  releaseRepository,
  releaseVersion,
  run,
  updateEnclosures,
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
  notes,
  baselines = [],
}) {
  releaseVersion(version);
  if (!privateKey) throw new Error("SPARKLE_ED_PRIVATE_KEY is required to sign the appcast");
  publicKey(key);
  const sparkle = ensureSparkle();
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-appcast-"));
  const archive = basename(archivePath);
  const temporaryFeed = join(directory, "appcast.xml");
  try {
    copyFileSync(archivePath, join(directory, archive));
    for (const baseline of baselines) {
      releaseVersion(baseline.version);
      copyFileSync(baseline.archivePath, join(directory, basename(baseline.archivePath)));
    }

    if (notes !== undefined) {
      if (!notes.trim()) throw new Error("Release notes must not be empty");
      writeFileSync(join(directory, `${basename(archive, ".zip")}.md`), notes);
    }

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
        ...(notes !== undefined ? ["--embed-release-notes"] : []),
        "--maximum-versions",
        "1",
        "--maximum-deltas",
        String(maximumDeltas),
        "-o",
        temporaryFeed,
        directory,
      ],
      { input, stdio: ["pipe", "inherit", "inherit"] },
    );
    run(join(sparkle, "bin/sign_update"), ["--verify", "--ed-key-file", "-", temporaryFeed], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    const feed = readFileSync(temporaryFeed);
    const xml = feed.toString("utf8");
    const fullArchive = readFileSync(archivePath);
    verifySignedAppcast({ feed, key });
    verifyUpdateArchive({
      xml,
      archive: fullArchive,
      key,
      version,
      url: `${urlPrefix}${encodeURIComponent(archive)}`,
    });

    const enclosures = updateEnclosures(xml, version);
    const deltaItems = enclosures.filter((item) => item.deltaFrom !== undefined);
    const filenames = readdirSync(directory).filter((filename) => filename.endsWith(".delta"));
    if (enclosures.length !== 1 + deltaItems.length || deltaItems.length !== filenames.length) {
      throw new Error("Generated appcast and update files do not match");
    }
    const deltas = filenames.map((filename) => {
      const url = `${urlPrefix}${encodeURIComponent(filename)}`;
      const item = deltaItems.find((entry) => entry.url === url);
      if (!item || !baselines.some((baseline) => baseline.version === item.deltaFrom)) {
        throw new Error(`Delta does not match an expected baseline: ${filename}`);
      }
      const patch = readFileSync(join(directory, filename));
      verifyUpdateArchive({ xml, archive: patch, key, version, url, deltaFrom: item.deltaFrom });
      console.info(
        `Delta ${item.deltaFrom} -> ${version}: ${patch.length}/${fullArchive.length} bytes`,
        `(${((patch.length / fullArchive.length) * 100).toFixed(1)}% of full ZIP)`,
      );
      return { filename, deltaFrom: item.deltaFrom, length: patch.length };
    });

    mkdirSync(dirname(output), { recursive: true });
    for (const { filename } of deltas) {
      copyFileSync(join(directory, filename), join(dirname(output), filename));
    }
    copyFileSync(temporaryFeed, output);
    console.info(
      `Signed Sparkle appcast generated for ${version};`,
      `deltas=${deltas.length};`,
      `release notes embedded=${notes !== undefined}`,
    );
    return deltas;
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
  normalizePrivateKey(process.env.SPARKLE_ED_PRIVATE_KEY);
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-delta-baselines-"));
  try {
    const baselines = downloadDeltaBaselines({
      directory,
      version,
      key: process.env.SPARKLE_ED_PUBLIC_KEY,
    });
    generateAppcast({
      archivePath: join(desktopDirectory, "dist", `XiaoWei-${version}-arm64.zip`),
      output: join(desktopDirectory, "dist/appcast.xml"),
      version,
      urlPrefix: `https://github.com/${releaseRepository}/releases/download/${tag}/`,
      notesUrl: `https://github.com/${releaseRepository}/releases`,
      notes: readReleaseNotes(version).markdown,
      key: process.env.SPARKLE_ED_PUBLIC_KEY,
      privateKey: process.env.SPARKLE_ED_PRIVATE_KEY,
      baselines,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
