import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const version = "v1.36.6";

export function projectProtocGenGo() {
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
      validate(join(bin, "protoc-gen-go"));
      try {
        renameSync(temp, destination);
      } catch (error) {
        if (!existsSync(executable)) throw error; // Reuse a concurrent successful installation.
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  validate(executable);
  return executable;
}

function validate(executable) {
  const actual = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `protoc-gen-go ${version}`) {
    throw new Error(`Invalid cached protoc-gen-go at ${executable}: ${actual}`);
  }
}
