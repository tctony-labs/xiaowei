import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../out/proto-server-swift/Package.swift",
);
const repository = "https://github.com/apple/swift-protobuf.git";
// Official 1.39.0 tag, shared with the runtime's checked-in SwiftPM resolution.
const revision = "3d537cb81aef272a03cb3be815439e9bf0eb3bd3";

export function ensureProtocGenSwift() {
  const version = readFileSync(manifest, "utf8").match(
    /swift-protobuf\.git",\s*exact:\s*"([0-9.]+)"/,
  )?.[1];
  if (!version) throw new Error(`Missing exact SwiftProtobuf requirement in ${manifest}`);
  const platform = `${process.platform}-${process.arch}`;
  const cache = join(homedir(), ".cache", "protoc-gen-swift");
  const destination = join(cache, `${version}-${platform}`);
  const executable = join(destination, "protoc-gen-swift");

  if (!existsSync(executable)) {
    mkdirSync(cache, { recursive: true });
    const temp = mkdtempSync(join(cache, ".install-"));
    const run = (command, args, options = {}) =>
      execFileSync(command, args, {
        stdio: "inherit",
        timeout: 600_000,
        ...options,
      });
    try {
      const source = join(temp, "source");
      run("git", ["clone", "--quiet", "--depth", "1", "--branch", version, repository, source]);
      const capture = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
      const actual = run("git", ["-C", source, "rev-parse", "HEAD"], capture).trim();
      if (actual !== revision) throw new Error("SwiftProtobuf source revision mismatch");
      const build = join(temp, "build");
      const args = ["--package-path", source, "--scratch-path", build, "-c", "release"];
      run("swift", ["build", ...args, "--product", "protoc-gen-swift"]);
      const bin = run("swift", ["build", ...args, "--show-bin-path"], capture).trim();
      const prepared = join(temp, "prepared");
      mkdirSync(prepared);
      copyFileSync(join(bin, "protoc-gen-swift"), join(prepared, "protoc-gen-swift"));
      validate(join(prepared, "protoc-gen-swift"), version);
      writeFileSync(join(prepared, "installation.json"), JSON.stringify({ platform, revision }));
      try {
        renameSync(prepared, destination);
      } catch (error) {
        if (!existsSync(executable)) throw error;
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  validate(executable, version);
  const metadata = JSON.parse(readFileSync(join(destination, "installation.json"), "utf8"));
  if (metadata.platform !== platform || metadata.revision !== revision) {
    throw new Error(
      `Cached protoc-gen-swift does not match this platform/revision: ${destination}`,
    );
  }
  return executable;
}

function validate(executable, version) {
  const actual = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `protoc-gen-swift ${version}`) {
    throw new Error(`Invalid cached protoc-gen-swift: ${actual}`);
  }
}
