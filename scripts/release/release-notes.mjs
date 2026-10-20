import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDirectory, releaseVersion } from "./sparkle.mjs";

export function readReleaseNotes(version, directory = join(desktopDirectory, "release-notes")) {
  releaseVersion(version);
  const path = join(directory, `${version}.md`);
  const markdown = readFileSync(path, "utf8");
  const [heading, ...lines] = markdown.trim().split(/\r?\n/);
  if (heading !== `# XiaoWei ${version}`) {
    throw new Error(`Release notes must start with "# XiaoWei ${version}": ${path}`);
  }

  const content = lines.join("\n").replace(/<!--[\s\S]*?-->/g, "");
  if (!content.split("\n").some((line) => line.trim() && !/^\s*#/.test(line))) {
    throw new Error(`Release notes must contain update details: ${path}`);
  }
  return { path, markdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));
  const version = releaseVersion(pkg.version);
  if (process.argv.length !== 3 || process.argv[2] !== `v${version}`) {
    throw new Error(`Expected release tag v${version} matching desktop/package.json`);
  }
  const notes = readReleaseNotes(version);
  console.info(`Release notes verified for ${version}: ${notes.path}`);
}
