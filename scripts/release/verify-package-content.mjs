import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage, statFile } from "@electron/asar";

export const nativePackages = ["xiaowei-agent", "xiaowei-rust"];

export function verifyPackageContent(app) {
  const archive = join(app, "Contents/Resources/app.asar");
  const required = new Set([
    "package.json",
    "out/main/index.js",
    "out/main/llm-worker.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    ...nativePackages.flatMap((name) => [
      `node_modules/${name}/package.json`,
      `node_modules/${name}/index.js`,
      `node_modules/${name}/${name}.darwin-arm64.node`,
    ]),
  ]);
  const allowedNative = new Set([...required].filter((path) => path.startsWith("node_modules/")));
  const unpacked = new Set();
  const files = [];
  for (const entry of listPackage(archive)) {
    const path = entry.replace(/^\//, "");
    const stat = statFile(archive, path, false);
    if (stat.link) throw new Error(`Unexpected package link: ${path}`);
    if (stat.files) continue;
    const allowedOutput =
      /^out\/main\/(?:index|llm-worker)\.js$/.test(path) ||
      /^out\/main\/chunks\/[^/]+\.js$/.test(path) ||
      path === "out/preload/index.cjs" ||
      path === "out/renderer/index.html" ||
      /^out\/renderer\/assets\/[^/]+\.(?:js|css|png|svg|ico|jpg|webp|woff2?)$/.test(path);
    if (path !== "package.json" && !allowedNative.has(path) && !allowedOutput) {
      throw new Error(`Unexpected package file: ${path}`);
    }
    if (/\.(?:js|cjs|css)$/.test(path)) {
      const content = extractFile(archive, path).toString("utf8");
      if (/sourceMappingURL=/.test(content))
        throw new Error(`Unexpected source map reference: ${path}`);
    }
    if (path.endsWith(".node") && !stat.unpacked) {
      throw new Error(`Native binary must be unpacked: ${path}`);
    }
    if (stat.unpacked) unpacked.add(path);
    required.delete(path);
    files.push(path);
  }
  if (required.size) throw new Error(`Missing package files: ${[...required].join(", ")}`);

  const metadata = JSON.parse(extractFile(archive, "package.json"));
  if (metadata.main !== "out/main/index.js" || metadata.type !== "module") {
    throw new Error("Unexpected packaged application entry point");
  }
  const dependencies = Object.keys(metadata.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify([...nativePackages].sort())) {
    throw new Error(`Unexpected production dependencies: ${dependencies.join(", ")}`);
  }
  for (const name of nativePackages) {
    const pkg = JSON.parse(extractFile(archive, `node_modules/${name}/package.json`));
    if (pkg.name !== name || pkg.main !== "index.js") {
      throw new Error(`Unexpected native package entry point: ${name}`);
    }
  }

  function verifyUnpacked(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) verifyUnpacked(absolute, path);
      else if (!stat.isFile() || !unpacked.delete(path)) {
        throw new Error(`Unexpected unpacked file: ${path}`);
      }
    }
  }
  verifyUnpacked(`${archive}.unpacked`);
  if (unpacked.size) throw new Error(`Missing unpacked files: ${[...unpacked].join(", ")}`);
  console.info(
    `Packaged content verified: ${files.length} files, two native packages, no source maps or source directories`,
  );
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: verify-package-content.mjs <app>");
  verifyPackageContent(resolve(process.argv[2]));
}
