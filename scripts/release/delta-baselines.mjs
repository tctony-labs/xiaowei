import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  publicKey,
  releaseRepository,
  releaseVersion,
  run,
  verifySignedAppcast,
  verifyUpdateArchive,
} from "./sparkle.mjs";

export const maximumDeltas = 3;

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function selectDeltaBaselines(releases, version) {
  releaseVersion(version);
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) &&
        compareVersions(release.tag_name.slice(1), version) < 0,
    )
    .sort((left, right) => compareVersions(right.tag_name.slice(1), left.tag_name.slice(1)))
    .slice(0, maximumDeltas)
    .flatMap((release) => {
      const baselineVersion = release.tag_name.slice(1);
      const archive = `XiaoWei-${baselineVersion}-arm64.zip`;
      const required = [archive, "appcast.xml"];
      if (!required.every((name) => release.assets.some((asset) => asset.name === name))) {
        console.warn(`Skipping delta baseline ${baselineVersion}: missing update ZIP or appcast`);
        return [];
      }
      return [{ version: baselineVersion, tag: release.tag_name, archive }];
    });
}

export function downloadDeltaBaselines({ directory, version, key }) {
  publicKey(key);
  const result = run(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${releaseRepository}/releases?per_page=100`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const baselines = selectDeltaBaselines(JSON.parse(result.stdout).flat(), version);
  console.info(
    `Delta baselines for ${version}: ${baselines.map((item) => item.version).join(", ") || "none"}`,
  );

  return baselines.map((baseline) => {
    const destination = join(directory, baseline.version);
    mkdirSync(destination, { recursive: true });
    run("gh", [
      "release",
      "download",
      baseline.tag,
      "--repo",
      releaseRepository,
      "--pattern",
      baseline.archive,
      "--pattern",
      "appcast.xml",
      "--dir",
      destination,
    ]);

    const archivePath = join(destination, baseline.archive);
    const feed = readFileSync(join(destination, "appcast.xml"));
    const urlPrefix = `https://github.com/${releaseRepository}/releases/download/${baseline.tag}/`;
    verifySignedAppcast({ feed, key });
    verifyUpdateArchive({
      xml: feed.toString("utf8"),
      archive: readFileSync(archivePath),
      key,
      version: baseline.version,
      url: `${urlPrefix}${baseline.archive}`,
    });
    console.info(`Verified original delta baseline ${baseline.version}: ${baseline.archive}`);
    return { version: baseline.version, archivePath };
  });
}
