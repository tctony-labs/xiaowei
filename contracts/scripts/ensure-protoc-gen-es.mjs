import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(contracts, "..");
const tsPackage = join(contracts, "ts");

// protoc-gen-es is pinned by the workspace lockfile; reuse pnpm instead of keeping a separate cache.
// Its version comes from the workspace catalog, which also pins the runtime; Protobuf-ES requires both
// to match.
export function ensureProtocGenEs() {
  const catalog = readCatalog();
  const version = catalog.get("@bufbuild/protoc-gen-es");
  const runtime = catalog.get("@bufbuild/protobuf");
  if (!version || !runtime) {
    throw new Error("Missing @bufbuild/protoc-gen-es or @bufbuild/protobuf in the pnpm-workspace.yaml catalog");
  }
  if (version !== runtime) {
    throw new Error(
      `pnpm-workspace.yaml catalog: @bufbuild/protoc-gen-es ${version} must equal @bufbuild/protobuf ${runtime}`,
    );
  }

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

// Reads the flat `catalog:` map; named catalogs are not used here.
function readCatalog() {
  const lines = readFileSync(join(workspace, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "catalog:");
  const entries = new Map();
  if (start === -1) return entries;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const entry = line.match(/^\s+["']?([^"':\s]+)["']?:\s*["']?([^"'\s#]+)["']?/);
    if (!entry) break;
    entries.set(entry[1], entry[2]);
  }
  return entries;
}

function installedVersion(executable) {
  const output = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  return output.replace(/^protoc-gen-es v/, "");
}
