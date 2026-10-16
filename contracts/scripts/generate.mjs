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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(root, "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error("Usage: generate.mjs [--check]");
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: workspace, stdio: "inherit", ...options });
const protoc = ensureProtoc();
const protocGenGo = ensureProtocGenGo();
const protocGenEs = ensureProtocGenEs();

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    )
    .sort();
}

function checkFingerprint() {
  const paths = [
    ...files(join(root, "proto")).filter((file) => file.endsWith(".proto")),
    ...files(join(root, "scripts")),
    ...files(join(root, "tools/src")),
    ...files(join(workspace, ".cargo")),
    ...files(join(root, "ts/src/gen")),
    ...files(join(root, "rust/src/gen")),
    ...files(join(root, "go/gen")),
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
      "contracts/ts/package.json",
      "contracts/ts/proto-selection.mjs",
      "contracts/go/go.mod",
      "contracts/go/go.sum",
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

// Load workspace dependencies only after ensureProtocGenEs has prepared them.
const { selectProtoFiles } = await import("../ts/proto-selection.mjs");

const temp = mkdtempSync(join(tmpdir(), "contracts-"));
try {
  const ts = join(temp, "ts");
  const rust = join(temp, "rust");
  const go = join(temp, "go");
  for (const dir of [ts, rust, go]) mkdirSync(dir);
  const proto = join(root, "proto");
  const inputs = files(proto).filter((file) => file.endsWith(".proto"));
  const includes = [`-I${proto}`, `-I${resolve(protoc, "../../include")}`];
  const descriptor = join(temp, "inputs.bin");
  run(protoc, [...includes, `--descriptor_set_out=${descriptor}`, "--include_imports", ...inputs]);
  const selected = selectProtoFiles(
    readFileSync(descriptor),
    JSON.parse(readFileSync(join(root, "generate.config.json"), "utf8")),
    inputs.map((file) => relative(proto, file)),
  );
  if (selected.ts.length) {
    run(
      protoc,
      [
        ...includes,
        `--plugin=protoc-gen-es=${protocGenEs}`,
        `--es_out=${ts}`,
        "--es_opt=target=ts",
        ...selected.ts,
      ],
      {
        // @typescript/vfs probes localStorage on import; this CLI does not use Web Storage.
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage`,
        },
      },
    );
  }
  if (selected.go.length) {
    const goModule = readFileSync(join(root, "go/go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1];
    if (!goModule) throw new Error("Missing module declaration in contracts/go/go.mod");
    run(protoc, [
      ...includes,
      `--plugin=protoc-gen-go=${protocGenGo}`,
      `--go_out=${go}`,
      "--go_opt=paths=source_relative",
      ...selected.go.map(
        (file) => `--go_opt=M${file}=${posix.join(goModule, "gen", dirname(file))}`,
      ),
      ...selected.go,
    ]);
  }
  if (selected.rust.length) {
    run(
      "cargo",
      [
        "run",
        "--locked",
        "--quiet",
        "-p",
        "xw-contracts-codegen",
        "--",
        rust,
        proto,
        ...selected.rust.map((file) => join(proto, file)),
      ],
      {
        env: { ...process.env, PROTOC: protoc, PROTOC_INCLUDE: resolve(protoc, "../../include") },
      },
    );
  }
  const outputs = [
    [ts, join(root, "ts/src/gen")],
    [rust, join(root, "rust/src/gen")],
    [go, join(root, "go/gen")],
  ];
  const drift = [];
  for (const [source, destination] of outputs) {
    if (check) {
      const names = new Set([
        ...files(source).map((f) => f.slice(source.length + 1)),
        ...files(destination).map((f) => f.slice(destination.length + 1)),
      ]);
      for (const name of names) {
        const a = join(source, name);
        const b = join(destination, name);
        if (!existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b))) {
          drift.push(join(destination, name));
        }
      }
    } else {
      rmSync(destination, { recursive: true, force: true });
      cpSync(source, destination, { recursive: true });
    }
  }
  if (drift.length)
    throw new Error(`Stale contracts; run pnpm contracts:generate:\n${drift.join("\n")}`);
  // Do not cache a check if its inputs or outputs changed while generators were running.
  if (check && checkFingerprint() === fingerprint) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, fingerprint);
  }
  console.log(check ? "Contracts are up to date." : "Contracts generated.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
