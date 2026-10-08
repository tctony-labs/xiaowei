import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
if (!["version", "key"].includes(mode)) throw new Error("Usage: go-cache.mjs version|key");

const workspace = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

if (mode === "version") {
  const manifest = readFileSync(join(workspace, "server/go.mod"), "utf8");
  const toolchain = manifest.match(/^toolchain\s+go(\S+)/m)?.[1];
  const version = toolchain ?? manifest.match(/^go\s+(\S+)/m)?.[1];
  if (!version) throw new Error("No Go version in server/go.mod");
  console.log(`version=${version}`);
} else {
  const environment = JSON.parse(
    execFileSync("go", ["env", "-json", "GOMODCACHE", "GOCACHE", "GOVERSION"], { cwd: workspace, encoding: "utf8" }),
  );
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: workspace, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = tracked.filter((path) => {
    const absolute = join(workspace, path);
    return existsSync(absolute) && lstatSync(absolute).isFile();
  });
  const modules = files.filter((path) => /^(server|contracts\/go)\/go\.(mod|sum)$/.test(path));
  const builds = files.filter(
    (path) =>
      modules.includes(path) ||
      /^server\/.*\.(go|sql)$/.test(path) ||
      /^contracts\/go\/.*\.go$/.test(path) ||
      [".github/workflows/test.yml", "scripts/ci/go-cache.mjs"].includes(path),
  );

  function hash(contents) {
    return createHash("sha256").update(contents).digest("hex");
  }

  function fingerprint(inputs) {
    return hash(JSON.stringify(inputs.map((path) => [path, hash(readFileSync(join(workspace, path)))])));
  }

  const platform = process.env.RUNNER_OS ?? process.platform;
  const architecture = process.env.RUNNER_ARCH ?? process.arch;
  const prefix = `go-v1-${platform}-${architecture}-${environment.GOVERSION}`;
  console.log(`module-path=${environment.GOMODCACHE}`);
  console.log(`build-path=${environment.GOCACHE}`);
  console.log(`prefix=${prefix}`);
  console.log(`module-hash=${fingerprint(modules)}`);
  console.log(`build-hash=${fingerprint(builds)}`);
  console.error(`Go cache: ${environment.GOVERSION}, ${modules.length} module inputs, ${builds.length} build inputs`);
}
