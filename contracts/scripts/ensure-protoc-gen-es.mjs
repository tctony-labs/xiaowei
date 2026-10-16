import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(contracts, "..");
const tsPackage = join(contracts, "ts");

// protoc-gen-es is pinned by the workspace lockfile; reuse pnpm instead of keeping a separate cache.
export function ensureProtocGenEs() {
  const version = JSON.parse(readFileSync(join(tsPackage, "package.json"), "utf8")).devDependencies?.[
    "@bufbuild/protoc-gen-es"
  ];
  if (!version) throw new Error("Missing @bufbuild/protoc-gen-es in contracts/ts/package.json devDependencies");

  const executable = join(tsPackage, "node_modules", ".bin", "protoc-gen-es");
  const installed = existsSync(executable) ? installedVersion(executable) : "missing";
  if (installed !== version) {
    console.log(`[contracts] Preparing protoc-gen-es: want ${version}, got ${installed}; running pnpm install.`);
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: workspace, stdio: "inherit" });
  }

  const actual = existsSync(executable) ? installedVersion(executable) : "missing";
  if (actual !== version) {
    throw new Error(`Invalid protoc-gen-es at ${executable}: want ${version}, got ${actual}`);
  }
  return executable;
}

function installedVersion(executable) {
  const output = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  return output.replace(/^protoc-gen-es v/, "");
}
