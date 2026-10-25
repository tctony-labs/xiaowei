import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startApplicationInspect } from "../src/main/services/inspect/host.ts";
import { INSPECT_MAX_BYTES } from "../src/main/services/inspect/protocol.ts";
import { ensureInspectDirectory, inspectSocketPath } from "../src/main/services/inspect/target.ts";

// Build the actual client once. The fixtures below host TS owners, not Electron instances.
const artifacts = execFileSync(
  "cargo",
  [
    "build",
    "--quiet",
    "--locked",
    "--manifest-path",
    fileURLToPath(new URL("../../Cargo.toml", import.meta.url)),
    "-p",
    "xiaowei-inspect",
    "--message-format=json",
  ],
  { encoding: "utf8" },
);
const binary = artifacts
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((entry) => entry.target?.name === "xiaowei-inspect" && entry.executable)?.executable;
assert.ok(binary, "Cargo must report the actual CLI executable");

function run(args, executable = binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI fixture exceeded its deadline"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function directory(t) {
  const path = await realpath(await mkdtemp("/tmp/xwi-cli-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function application(t, source) {
  let visible = false;
  let mode = "search";
  const server = await startApplicationInspect({
    source,
    version: "fixture",
    appPath: source.path,
    dataPath: "/unchanged/shared-data",
    status: () => ({ launcher: { mode }, dock: { visible: false } }),
    windows: () => [
      { id: 1, role: "launcher", visible, focused: visible, alwaysOnTop: mode !== "quick-chat" },
    ],
    shortcuts: () => [{ action: "quickChat", accelerator: "Command+Shift+C", state: "suspended" }],
    async showLauncher(next) {
      visible = true;
      mode = next;
    },
    async hideLauncher() {
      visible = false;
      return true;
    },
  });
  t.after(() => server.close());
  return server;
}

test("real Rust CLI queries and controls the TS owner across a workspace symlink", async (t) => {
  const path = await directory(t);
  const alias = `${path}-alias`;
  await symlink(path, alias);
  t.after(() => rm(alias));
  await application(t, { kind: "workspace", path });
  const query = async (...args) => {
    const result = await run(["--workspace", alias, "--json", ...args]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const hidden = await query("status");
  assert.equal(hidden.source.path, path);
  assert.equal(hidden.result.windows[0].visible, false);
  assert.equal((await query("identify")).result.dataPath, "/unchanged/shared-data");
  assert.equal((await query("shortcuts")).result[0].state, "suspended");
  assert.ok((await query("capabilities")).result.methods.length > 0);
  for (const mode of ["quick-chat", "quick-chat", "search", "clipboard"]) {
    const shown = await query("show", mode);
    assert.equal(shown.result.windows[0].visible, true);
    assert.equal(shown.result.state.launcher.mode, mode);
  }
  const hiddenAgain = await query("hide");
  assert.equal(hiddenAgain.result.windows[0].visible, false);
  assert.equal(hiddenAgain.result.focusRestored, true);
  const text = await run(["--workspace", path, "shortcuts"]);
  assert.match(text.stdout, /quickChat: Command\+Shift\+C \(suspended\)/);
});

test("a bundled CLI and its PATH symlink select their App, regardless of cwd", async (t) => {
  const root = await directory(t);
  const path = join(root, "XiaoWei 测试 App.app");
  const packaged = join(path, "Contents/Resources/bin/xiaowei-inspect");
  await mkdir(dirname(packaged), { recursive: true });
  await writeFile(join(path, "Contents/Info.plist"), "<plist><dict/></plist>");
  await copyFile(binary, packaged);
  await chmod(packaged, 0o755);
  const link = join(root, "xiaowei-inspect");
  await symlink(packaged, link);
  const source = { kind: "app", path };
  await application(t, source);
  for (const executable of [packaged, link]) {
    const result = await run(["identify", "--json"], executable);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).source, source);
  }
});

async function fakeServer(t, reply) {
  const source = { kind: "workspace", path: await directory(t) };
  const path = inspectSocketPath(source);
  await ensureInspectDirectory(dirname(path));
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      reply(socket, JSON.parse(received));
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { path, source };
}

for (const failure of ["id", "version", "source", "incomplete", "oversized", "timeout"]) {
  test(`Rust client rejects ${failure} replies and preserves structured errors`, async (t) => {
    const server = await fakeServer(t, (socket, request) => {
      if (failure === "timeout") return;
      if (failure === "incomplete") return socket.end("{");
      if (failure === "oversized") return socket.end("x".repeat(INSPECT_MAX_BYTES + 1));
      const response = { ...request, ok: true, result: {} };
      if (failure === "id") response.id = "another-request";
      if (failure === "version") response.version = 2;
      if (failure === "source") response.source = { ...request.source, path: "/another-source" };
      const frame = `${JSON.stringify(response)}\n`;
      socket.write(frame.slice(0, 10));
      setImmediate(() => socket.end(frame.slice(10)));
    });
    const result = await run(["--workspace", server.source.path, "status", "--json"]);
    assert.equal(result.code, 1);
    const errors = {
      id: "INVALID_RESPONSE",
      version: "VERSION_MISMATCH",
      source: "SOURCE_MISMATCH",
      incomplete: "NO_RESPONSE",
      oversized: "FRAME_TOO_LARGE",
      timeout: "TIMEOUT",
    };
    assert.equal(JSON.parse(result.stdout).error.code, errors[failure]);
  });
}

test("unsafe socket permissions are refused before sending a request", async (t) => {
  let requests = 0;
  const server = await fakeServer(t, () => requests++);
  await chmod(server.path, 0o666);
  const result = await run(["--workspace", server.source.path, "status", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "UNSAFE_SOCKET");
  assert.equal(requests, 0);
});

test("Rust client returns the host's operation failure without claiming success", async (t) => {
  const server = await fakeServer(t, (socket, request) => {
    socket.end(
      `${JSON.stringify({
        ...request,
        ok: false,
        error: { code: "HANDLER_ERROR", message: "window did not become visible" },
      })}\n`,
    );
  });
  const result = await run(["--workspace", server.source.path, "show", "search", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "HANDLER_ERROR");
});
