import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const protocVersion = "36.2";
// Digests published on the official protocolbuffers/protobuf v36.2 release.
const archives = {
  "darwin-arm64": ["osx-aarch_64", "9cd98a532c5c5e0c4161314de0225de27e4c8a323917b6ea7b1b714d3ae23466"],
  "darwin-x64": ["osx-x86_64", "228cc7add4616cc14ca5e80dee83209d44449a7aee95a914ae748fa374efb078"],
  "linux-arm64": ["linux-aarch_64", "8b8f18bd2b30346efbc698dd5a73dd7c805f3ef8380f6dfc95c768f3f1852f6a"],
  "linux-x64": ["linux-x86_64", "121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278"],
};

export function projectProtoc() {
  const platform = `${process.platform}-${process.arch}`;
  const archive = archives[platform];
  if (!archive) throw new Error(`Project protoc download is not configured for ${platform}`);
  const cache = join(homedir(), ".cache", "protoc");
  const destination = join(cache, protocVersion);
  const executable = join(destination, "bin", "protoc");
  if (!existsSync(executable)) {
    mkdirSync(cache, { recursive: true });
    const temp = mkdtempSync(join(cache, ".download-"));
    try {
      const zip = join(temp, "protoc.zip");
      const url =
        `https://github.com/protocolbuffers/protobuf/releases/download/v${protocVersion}/` +
        `protoc-${protocVersion}-${archive[0]}.zip`;
      execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", zip, url], {
        stdio: "inherit",
      });
      const digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
      if (digest !== archive[1]) throw new Error("protoc archive SHA-256 mismatch");
      execFileSync("unzip", ["-q", zip, "-d", join(temp, "unpacked")]);
      const unpacked = join(temp, "unpacked");
      validate(unpacked);
      writeFileSync(join(unpacked, "installation.json"), `${JSON.stringify({ platform, sha256: digest })}\n`);
      try {
        renameSync(join(temp, "unpacked"), destination);
      } catch (error) {
        if (!existsSync(executable)) throw error; // Another generator may have completed the same install.
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  validate(destination);
  const installation = JSON.parse(readFileSync(join(destination, "installation.json"), "utf8"));
  if (installation.platform !== platform || installation.sha256 !== archive[1]) {
    throw new Error(`Cached protoc does not match this platform/release: ${destination}`);
  }
  return executable;
}

function validate(directory) {
  const actual = execFileSync(join(directory, "bin", "protoc"), ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `libprotoc ${protocVersion}`) throw new Error(`Invalid cached protoc: ${actual}`);
  if (!existsSync(join(directory, "include/google/protobuf/descriptor.proto"))) {
    throw new Error(`Incomplete protoc include directory: ${directory}`);
  }
}
