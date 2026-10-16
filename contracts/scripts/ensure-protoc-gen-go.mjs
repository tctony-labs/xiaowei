import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const goMod = resolve(dirname(fileURLToPath(import.meta.url)), "../go/go.mod");

// protoc-gen-go ships in google.golang.org/protobuf, so the runtime required by contracts/go pins the
// generator too.
export function ensureProtocGenGo() {
  const version = goProtobufVersion(goMod);
  const cache = join(homedir(), ".cache", "protoc-gen-go");
  const destination = join(cache, version);
  const executable = join(destination, "bin", "protoc-gen-go");
  if (!existsSync(executable)) {
    mkdirSync(cache, { recursive: true });
    const temp = mkdtempSync(join(cache, ".install-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin);
      execFileSync("go", ["install", `google.golang.org/protobuf/cmd/protoc-gen-go@${version}`], {
        env: { ...process.env, GOBIN: bin },
        stdio: "inherit",
      });
      validate(join(bin, "protoc-gen-go"), version);
      try {
        renameSync(temp, destination);
      } catch (error) {
        if (!existsSync(executable)) throw error; // Reuse a concurrent successful installation.
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  validate(executable, version);
  return executable;
}

function goProtobufVersion(file) {
  const version = readFileSync(file, "utf8").match(
    /^\s*(?:require\s+)?google\.golang\.org\/protobuf\s+(v\S+)/m,
  )?.[1];
  if (!version) throw new Error(`Missing google.golang.org/protobuf requirement in ${file}`);
  return version;
}

function validate(executable, version) {
  const actual = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `protoc-gen-go ${version}`) {
    throw new Error(`Invalid cached protoc-gen-go at ${executable}: ${actual}`);
  }
}
