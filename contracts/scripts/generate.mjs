import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProtoc } from "./ensure-protoc.mjs";
import { ensureProtocGenEs } from "./ensure-protoc-gen-es.mjs";
import { ensureProtocGenGo } from "./ensure-protoc-gen-go.mjs";
import { selectProtoFiles, targetLayout } from "./proto-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(root, "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: generate.mjs [--check]");
}

const config = JSON.parse(readFileSync(join(root, "generate.config.json"), "utf8"));
const targetNames = [...new Set(Object.values(config.sources).flat())].sort();
const layouts = targetNames.map((name) => ({ name, ...targetLayout(name) }));
for (const layout of layouts) {
  const manifest = { rust: "Cargo.toml", ts: "package.json", go: "go.mod" }[layout.language];
  const path = join(workspace, layout.output, manifest);
  if (!existsSync(path)) throw new Error(`Missing fixed contract package: ${path}`);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: workspace, stdio: "inherit", ...options });
const protoc = ensureProtoc();
const protocGenGo = ensureProtocGenGo();
const protocGenEs = ensureProtocGenEs();

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
    )
    .sort();
}

function checkFingerprint() {
  const paths = [
    ...files(join(root, "proto")).filter((file) => file.endsWith(".proto")),
    ...files(join(root, "scripts")),
    ...files(join(root, "tools/src")),
    ...files(join(workspace, ".cargo")),
    ...layouts.flatMap((layout) => [
      ...files(join(workspace, layout.generated)),
      ...[
        "Cargo.toml",
        "package.json",
        "tsconfig.json",
        "go.mod",
        "go.sum",
        "src/lib.rs",
        "src/index.ts",
        "src/server-api.ts",
      ].map((path) => join(workspace, layout.output, path)),
    ]),
    ...[
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".node-version",
      "contracts/generate.config.json",
      "contracts/tools/Cargo.toml",
      "contracts/tools/build.rs",
    ].map((path) => join(workspace, path)),
  ].sort();
  const entries = paths.map((path) => [
    relative(workspace, path),
    existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
  ]);
  const environment = [
    process.platform,
    process.arch,
    process.version,
    process.env.NODE_OPTIONS,
    process.env.RUSTUP_TOOLCHAIN,
    process.env.RUSTFLAGS,
    process.env.CARGO_ENCODED_RUSTFLAGS,
    protoc,
    protocGenGo,
    protocGenEs,
  ];
  return createHash("sha256")
    .update(JSON.stringify([environment, entries]))
    .digest("hex");
}

const cachePath = join(workspace, "target/contracts-check.sha256");
const fingerprint = check ? checkFingerprint() : null;
if (check && existsSync(cachePath) && readFileSync(cachePath, "utf8") === fingerprint) {
  console.log("Contracts are up to date (cached; inputs and generated files unchanged).");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "contracts-"));
try {
  const proto = join(root, "proto");
  const inputs = files(proto).filter((file) => file.endsWith(".proto"));
  const includes = [`-I${proto}`, `-I${resolve(protoc, "../../include")}`];
  const descriptor = join(temp, "inputs.bin");
  run(protoc, [...includes, `--descriptor_set_out=${descriptor}`, "--include_imports", ...inputs]);
  const selected = selectProtoFiles(
    readFileSync(descriptor),
    config,
    inputs.map((file) => relative(proto, file)),
  );

  const outputs = [];
  for (const [name, target] of Object.entries(selected)) {
    const output = join(temp, name);
    mkdirSync(output);
    console.log(`[contracts] Generating ${name}: ${target.files.length} proto files`);
    if (target.language === "ts") {
      run(
        protoc,
        [
          ...includes,
          `--plugin=protoc-gen-es=${protocGenEs}`,
          `--es_out=${output}`,
          "--es_opt=target=ts",
          ...target.files,
        ],
        {
          env: {
            ...process.env,
            // @typescript/vfs probes localStorage; the generator does not use Web Storage.
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage`,
          },
        },
      );
    } else if (target.language === "go") {
      const manifest = join(workspace, target.output, "go.mod");
      const module = readFileSync(manifest, "utf8").match(/^module\s+(\S+)/m)?.[1];
      if (!module) throw new Error(`Missing module declaration in ${manifest}`);
      run(protoc, [
        ...includes,
        `--plugin=protoc-gen-go=${protocGenGo}`,
        `--go_out=${output}`,
        "--go_opt=paths=source_relative",
        ...target.files.map(
          (file) => `--go_opt=M${file}=${posix.join(module, "gen", dirname(file))}`,
        ),
        ...target.files,
      ]);
    } else {
      run(
        "cargo",
        [
          "run",
          "--locked",
          "--quiet",
          "-p",
          "xw-contracts-codegen",
          "--",
          output,
          proto,
          ...target.files.map((file) => join(proto, file)),
        ],
        {
          env: { ...process.env, PROTOC: protoc, PROTOC_INCLUDE: resolve(protoc, "../../include") },
        },
      );
    }
    outputs.push([output, join(workspace, target.generated)]);
  }

  const drift = [];
  for (const [source, destination] of outputs) {
    if (check) {
      const names = new Set([
        ...files(source).map((file) => relative(source, file)),
        ...files(destination).map((file) => relative(destination, file)),
      ]);
      for (const name of names) {
        const generated = join(source, name);
        const existing = join(destination, name);
        if (
          !existsSync(generated) ||
          !existsSync(existing) ||
          !readFileSync(generated).equals(readFileSync(existing))
        ) {
          drift.push(join(destination, name));
        }
      }
    } else {
      rmSync(destination, { recursive: true, force: true });
      cpSync(source, destination, { recursive: true });
    }
  }
  if (drift.length) {
    throw new Error(`Stale contracts; run pnpm contracts:generate:\n${drift.join("\n")}`);
  }
  // Do not cache a check if inputs or outputs changed while the generators ran.
  if (check && checkFingerprint() === fingerprint) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, fingerprint);
  }
  console.log(check ? "Contracts are up to date." : "Contracts generated.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
