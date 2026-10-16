import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { start as startPostgres } from "./pgsql.mjs";
import { checkServerPort, runServerDevelopment } from "./server.mjs";
import { ensureServerConfiguration } from "./server-config.mjs";

function configuration(context) {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-server-prepare-"));
  mkdirSync(join(root, "server/config"), { recursive: true });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function listener(context) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, address: `127.0.0.1:${server.address().port}` };
}

test("port check reports actual listener and parent without terminating it", async (context) => {
  if (spawnSync("lsof", ["-v"]).error?.code === "ENOENT") {
    context.skip("process diagnostics require lsof");
    return;
  }
  const root = configuration(context);
  const { server, address } = await listener(context);
  writeFileSync(join(root, "server/config/server.yaml"), `server: {listen_addr: '${address}'}`);
  const output = [];
  await assert.rejects(
    checkServerPort({
      root,
      env: {},
      print: (line) => output.push(line),
      confirm: async (question) => {
        assert.ok(question.includes(`PID: ${process.pid}`));
        return false;
      },
    }),
    /未确认终止进程/,
  );
  const report = output.join("\n");
  for (const expected of [address, `PID=${process.pid}`, `PPID=${process.ppid}`, "cwd="]) {
    assert.ok(report.includes(expected), `missing ${expected}: ${report}`);
  }
  assert.equal(server.listening, true);
});

test("port check honors YAML, dotenv and external environment priority and releases the port", async (context) => {
  const root = configuration(context);
  const occupied = await listener(context);
  const available = await listener(context);
  await new Promise((resolve) => available.server.close(resolve));
  const yamlPath = join(root, "server/config/server.yaml");
  const envPath = join(root, "server/config/.env");

  writeFileSync(yamlPath, `server:\n  listen_addr: "${available.address}"\n`);
  await checkServerPort({ root, env: {} });

  writeFileSync(yamlPath, `server: {listen_addr: '${occupied.address}'}`);
  writeFileSync(envPath, `XIAOWEI_LISTEN_ADDR='${available.address}' # local override\n`);
  await checkServerPort({ root, env: {} });

  writeFileSync(envPath, `XIAOWEI_LISTEN_ADDR=${occupied.address}\n`);
  await checkServerPort({ root, env: { XIAOWEI_LISTEN_ADDR: available.address } });
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(Number(available.address.split(":")[1]), "127.0.0.1", () => probe.close(resolve));
  });
});

test("port check reports missing diagnostics tools and keeps conflict fatal", async (context) => {
  const root = configuration(context);
  const { address } = await listener(context);
  writeFileSync(join(root, "server/config/server.yaml"), `server: {listen_addr: '${address}'}`);
  const path = process.env.PATH;
  process.env.PATH = root;
  const output = [];
  try {
    await assert.rejects(
      checkServerPort({ root, env: {}, print: (line) => output.push(line) }),
      /无法确认占用进程/,
    );
    assert.ok(output.some((line) => line.includes("无法取得监听进程信息")));
  } finally {
    process.env.PATH = path;
  }
});

test("invalid configuration fails without exposing its contents", async (context) => {
  const root = configuration(context);
  writeFileSync(join(root, "server/config/server.yaml"), "password: [private-password");
  await assert.rejects(checkServerPort({ root, env: {} }), (error) => {
    assert.match(error.message, /无法读取/);
    assert.ok(!error.message.includes("private-password"));
    return true;
  });
  writeFileSync(
    join(root, "server/config/server.yaml"),
    "server: {listen_addr: 'localhost:99999'}",
  );
  await assert.rejects(checkServerPort({ root, env: {} }), /host:port/);
});

test("real development script rejects a conflict before invoking Go", async (context) => {
  const root = configuration(context);
  const { server, address } = await listener(context);
  const scriptDirectory = join(root, "scripts/dev");
  mkdirSync(scriptDirectory, { recursive: true });
  for (const name of ["server.mjs", "dev-process.mjs", "pgsql.mjs", "server-config.mjs"]) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(scriptDirectory, name));
  }
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(root, "node_modules"),
  );
  writeFileSync(
    join(root, "server/config/server.example.yaml"),
    "database: {password: private-password}",
  );
  writeFileSync(
    join(root, "server/config/.env.example"),
    "XIAOWEI_DATABASE_PASSWORD=private-password",
  );
  const marker = join(root, "go-invoked");
  writeFileSync(join(root, "go"), '#!/bin/sh\nprintf invoked > "$PORT_CHECK_MARKER"\n', {
    mode: 0o755,
  });
  const result = spawnSync(process.execPath, [realpathSync(join(scriptDirectory, "server.mjs"))], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH}`,
      XIAOWEI_LISTEN_ADDR: address,
      PORT_CHECK_MARKER: marker,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /取消启动/);
  assert.ok(result.stdout.includes(address));
  assert.ok(
    result.stdout.includes(`PID=${process.pid}`) || result.stdout.includes("无法取得监听进程信息"),
  );
  assert.ok(
    !result.stdout.includes("private-password") && !result.stderr.includes("private-password"),
  );
  assert.equal(existsSync(marker), false, "Go must not start when preflight fails");
  assert.equal(server.listening, true);
  assert.equal(
    readFileSync(join(root, "server/config/server.yaml"), "utf8"),
    "database: {password: private-password}",
  );
  assert.equal(
    readFileSync(join(root, "server/config/.env"), "utf8"),
    "XIAOWEI_DATABASE_PASSWORD=private-password",
  );
});

test("yes terminates the displayed listener and resumes after the port is released", async (context) => {
  const root = configuration(context);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createServer } from 'node:net';

    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      process.send({ address: '127.0.0.1:' + server.address().port });
    });
    process.on('SIGTERM', () => {
      setTimeout(() => server.close(() => process.exit(0)), 100);
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = once(child, "close");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const [{ address }] = await once(child, "message");
  writeFileSync(join(root, "server/config/server.yaml"), `server: {listen_addr: '${address}'}`);
  const output = [];
  let asked = false;
  await checkServerPort({
    root,
    env: {},
    print: (line) => output.push(line),
    confirm: async (question) => {
      assert.equal(child.exitCode, null, "occupant must remain alive until confirmation");
      assert.ok(question.includes(`PID: ${child.pid}`));
      asked = true;
      return true;
    },
  });
  assert.equal(asked, true);
  assert.deepEqual(await closed, [0, null]);
  assert.ok(output.some((line) => line.includes("已释放，继续启动")));
});

test("server configuration copies missing templates and preserves existing files", (context) => {
  const root = configuration(context);
  const output = [];
  const options = { root, print: (line) => output.push(line) };
  writeFileSync(
    join(root, "server/config/server.example.yaml"),
    "server: {listen_addr: '127.0.0.1:10001'}",
  );
  writeFileSync(join(root, "server/config/.env.example"), "XIAOWEI_DATABASE_PASSWORD=password");
  ensureServerConfiguration(options);
  assert.equal(
    readFileSync(join(root, "server/config/.env"), "utf8"),
    "XIAOWEI_DATABASE_PASSWORD=password",
  );
  assert.equal(
    readFileSync(join(root, "server/config/server.yaml"), "utf8"),
    "server: {listen_addr: '127.0.0.1:10001'}",
  );
  assert.equal(output.length, 2);
  writeFileSync(join(root, "server/config/.env"), "existing environment");
  writeFileSync(join(root, "server/config/server.yaml"), "existing configuration");
  output.length = 0;
  ensureServerConfiguration(options);
  assert.equal(readFileSync(join(root, "server/config/.env"), "utf8"), "existing environment");
  assert.equal(
    readFileSync(join(root, "server/config/server.yaml"), "utf8"),
    "existing configuration",
  );
  assert.equal(output.length, 0);
});

test("preparation delegates configuration validation to Docker startup", async (context) => {
  const root = configuration(context);
  writeFileSync(join(root, "server/config/.env"), "");
  writeFileSync(join(root, "server/config/server.yaml"), "");
  const calls = [];
  const options = { root, print: () => {}, run: async (...args) => calls.push(args) };
  await startPostgres(options);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(-6), ["up", "-d", "--wait", "--wait-timeout", "60", "db"]);
  assert.ok(!calls[0][1].includes("--force-recreate"));
  assert.ok(
    calls.every(([, args]) => !args.includes("down") && !args.includes("--renew-anon-volumes")),
  );
});

test("Docker startup failure is propagated without claiming dependencies are ready", async (context) => {
  const root = configuration(context);
  writeFileSync(join(root, "server/config/.env"), "");
  writeFileSync(join(root, "server/config/server.yaml"), "");
  let calls = 0;
  const output = [];
  const failure = new Error("Docker startup failed");
  await assert.rejects(
    startPostgres({
      root,
      print: (line) => output.push(line),
      run: async () => {
        calls++;
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.ok(!output.includes("共享 PostgreSQL 已就绪。"));
});

function fixture(context, overrides = {}, tty = true) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  const signals = new EventEmitter();
  const events = [];
  const children = [];
  const output = [];
  const controller = runServerDevelopment({
    input,
    signals,
    print: (line) => output.push(stripVTControlCharacters(line)),
    startServer: () => {
      events.push("start");
      const child = new EventEmitter();
      child.exitCode = null;
      child.finish = (code = 0) => {
        child.exitCode = code;
        child.emit("exit", code);
        child.emit("close", code);
      };
      children.push(child);
      return child;
    },
    stopServer: async (child, closed) => {
      events.push("stop");
      if (child.exitCode === null) child.finish();
      await closed;
    },
    ...overrides,
  });
  context.after(async () => {
    await controller.stop();
    input.destroy();
  });
  return { input, signals, events, children, output, controller };
}

test("r restarts only Go in order and R no longer restarts shared dependencies", async (context) => {
  const state = fixture(context);
  state.input.write("R");
  await state.controller.idle();
  assert.deepEqual(state.events, ["start"]);
  state.input.write("rr");
  await state.controller.idle();
  assert.deepEqual(state.events, ["start", "stop", "start", "stop", "start"]);
  state.input.write("h");
  assert.match(state.output.at(-1), /保留共享 PostgreSQL/);
});

test("Ctrl+C during restart skips replacement and queued restarts", async (context) => {
  let releaseStop;
  let first = true;
  const state = fixture(context, {
    stopServer: async (child, closed) => {
      state.events.push("stop");
      if (first) {
        first = false;
        await new Promise((resolve) => {
          releaseStop = resolve;
        });
      }
      if (child.exitCode === null) child.finish();
      await closed;
    },
  });
  state.input.write("rr");
  await new Promise(setImmediate);
  state.input.write("\x03");
  releaseStop();
  await state.controller.stop();
  assert.equal(state.children.length, 1);
  assert.equal(state.input.isRaw, false);
  assert.equal(state.signals.listenerCount("SIGTERM"), 0);
});

test("cleanup failure blocks replacement and reports failed exit", async (context) => {
  const state = fixture(context, {
    stopServer: async () => {
      throw new Error("group still alive");
    },
  });
  state.input.write("r");
  await state.controller.idle();
  assert.equal(state.children.length, 1);
  await state.controller.stop();
  assert.equal(state.signals.exitCode, 1);
  assert.match(state.output.at(-1), /退出失败/);
});

test("non-TTY preserves stdin and stops only Go once on SIGTERM", async (context) => {
  const state = fixture(context, {}, false);
  state.input.write("rRh");
  await state.controller.idle();
  assert.deepEqual(state.events, ["start"]);
  state.signals.emit("SIGTERM");
  state.signals.emit("SIGTERM");
  await state.controller.stop();
  assert.deepEqual(state.events, ["start", "stop"]);
});

test("Ctrl+C stops only Go and repeated stop does not run cleanup twice", async (context) => {
  const state = fixture(context);
  state.input.write("\x03");
  await state.controller.stop();
  await state.controller.stop();
  assert.deepEqual(state.events, ["start", "stop"]);
  assert.equal(state.input.isRaw, false);
  assert.equal(state.signals.exitCode, 0);
});

test("failed Go startup reports failure and r retries", async (context) => {
  const state = fixture(context);
  state.children[0].finish(1);
  assert.equal(state.signals.exitCode, 1);
  assert.match(state.output.at(-1), /按 r 重试/);
  state.input.write("r");
  await state.controller.idle();
  assert.equal(state.children.length, 2);
  assert.equal(state.signals.exitCode, 0);
});
