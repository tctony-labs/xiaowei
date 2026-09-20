import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runDevelopment } from "./dev.mjs";

function fixture(context, tty = true) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  const signals = new EventEmitter();
  const children = [];
  const output = [];
  let touches = 0;
  let autoClose = false;
  const controller = runDevelopment({
    input,
    signals,
    print: (message) => output.push(message),
    restartElectron: () => {
      touches++;
    },
    startSession: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kills = [];
      child.finish = () => {
        child.exitCode = 0;
        child.emit("exit", 0);
        child.emit("close", 0);
      };
      child.kill = (signal) => {
        child.kills.push(signal);
        if (autoClose) queueMicrotask(child.finish);
      };
      children.push(child);
      return child;
    },
  });
  context.after(async () => {
    autoClose = true;
    for (const child of children) if (child.kills.length && child.exitCode === null) child.finish();
    await controller.stop();
    input.destroy();
  });
  return { input, signals, children, output, controller, touches: () => touches };
}

test("r only touches the existing nodemon restart trigger; h lists registered commands", async (context) => {
  const state = fixture(context);
  assert.equal(state.input.isRaw, true);
  state.input.write("r");
  await state.controller.idle();
  assert.equal(state.touches(), 1);
  assert.equal(state.children.length, 1);
  assert.deepEqual(state.children[0].kills, []);
  state.input.write("h");
  assert.match(state.output.at(-1), /R .*Vite \+ Electron/);
  assert.match(state.output.at(-1), /r .*Electron/);
  assert.match(state.output.at(-1), /h .*命令列表/);
});

test("R waits for the old session to close, then starts a fresh one; queued r follows it", async (context) => {
  const state = fixture(context);
  state.input.write("Rr");
  await Promise.resolve();
  assert.deepEqual(state.children[0].kills, ["SIGTERM"]);
  assert.equal(state.children.length, 1);
  assert.equal(state.touches(), 0);
  state.children[0].finish();
  await state.controller.idle();
  assert.equal(state.children.length, 2);
  assert.equal(state.touches(), 1);
});

test("Ctrl+C during restart restores terminal mode and prevents another session", async (context) => {
  const state = fixture(context);
  state.input.write("R");
  await Promise.resolve();
  state.input.write("\x03");
  assert.equal(state.input.isRaw, false);
  state.children[0].finish();
  await state.controller.stop();
  assert.equal(state.children.length, 1);
  assert.equal(state.signals.listenerCount("SIGTERM"), 0);
});

test("non-TTY startup does not consume input and still handles SIGTERM", async (context) => {
  const state = fixture(context, false);
  state.input.write("Rrh");
  await state.controller.idle();
  assert.equal(state.touches(), 0);
  assert.equal(state.output.length, 0);
  state.signals.emit("SIGTERM");
  await Promise.resolve();
  assert.deepEqual(state.children[0].kills, ["SIGTERM"]);
  state.children[0].finish();
  await state.controller.stop();
});

test("R can recover from a failed development session", async (context) => {
  const state = fixture(context);
  const child = state.children[0];
  child.exitCode = 1;
  child.emit("exit", 1);
  child.emit("close", 1);
  assert.match(state.output.at(-1), /按 R 重试/);
  state.input.write("R");
  await state.controller.idle();
  assert.equal(state.children.length, 2);
  assert.deepEqual(child.kills, []);
});

test("start cleanup stops a respawning supervisor without leaving its replacement child", {
  timeout: 5000,
}, async () => {
  const supervisor = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    let stopping = false;
    let child;
    function start() {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid);
      child.once('exit', () => { if (!stopping) start(); });
    }
    process.on('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });
    start();
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(supervisor, "close");
  const pids = [];
  supervisor.stdout.on("data", (chunk) => {
    pids.push(...chunk.toString().trim().split(/\s+/).map(Number));
  });
  try {
    await once(supervisor.stdout, "data");
    const justfile = readFileSync(new URL("../../justfile", import.meta.url), "utf8");
    const start = justfile.indexOf("    kill_tree() {");
    const end = justfile.indexOf("\n    }", start) + "\n    }".length;
    const cleanup = justfile.slice(start, end);
    const cleanupProcess = spawn("bash", ["-c", `${cleanup}\nkill_tree "$1"`, "cleanup", String(supervisor.pid)]);
    let errors = "";
    cleanupProcess.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const [code] = await once(cleanupProcess, "close");
    assert.equal(code, 0, errors);
    await closed;
    assert.equal(pids.length, 1, "supervisor must not spawn a replacement during cleanup");
    assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" });
  } finally {
    supervisor.kill("SIGCONT");
    supervisor.kill("SIGKILL");
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});

test("R does not start a replacement when the old session fails to shut down", async (context) => {
  const state = fixture(context);
  state.input.write("R");
  await Promise.resolve();
  state.children[0].exitCode = 1;
  state.children[0].emit("exit", 1);
  state.children[0].emit("close", 1);
  await state.controller.idle();
  assert.equal(state.children.length, 1);
  assert.match(state.output.at(-1), /取消启动新实例/);
});

test("commands announce a separator and name before running", async (context) => {
  const state = fixture(context);
  state.input.write("r");
  await state.controller.idle();
  assert.match(state.output.at(-1), /─+\n\[r\] .*Electron\n─+/);
  state.input.write("h");
  assert.match(state.output.at(-2), /\[h\] 显示命令列表/);
  state.input.write("\x03");
  assert.match(state.output.at(-1), /\[Ctrl\+C\] 退出开发实例/);
  await Promise.resolve();
  state.children[0].finish();
  await state.controller.stop();
});

test("signal termination during Ctrl+C shutdown does not reject or print a restart error", async (context) => {
  const state = fixture(context);
  state.input.write("\x03");
  await Promise.resolve();
  state.signals.emit("SIGTERM");
  state.children[0].signalCode = "SIGTERM";
  state.children[0].emit("exit", null, "SIGTERM");
  state.children[0].emit("close", null, "SIGTERM");
  await assert.doesNotReject(state.controller.stop());
  assert.ok(!state.output.some((line) => line.includes("取消启动新实例")));
});

for (const stubborn of [false, true]) {
  test(`start waits for detached descendants after the root exits (ignores TERM: ${stubborn})`, {
    timeout: 25000,
  }, async () => {
    const appCode = `
      process.on('SIGTERM', () => { ${stubborn ? "" : "setTimeout(() => process.exit(0), 600);"} });
      console.log(process.pid);
      setInterval(() => {}, 1000);
    `;
    const supervisor = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(appCode)}], {
        detached: true, stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout.pipe(process.stdout);
      process.on('SIGTERM', () => process.exit(0));
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(supervisor, "close");
    let appPid;
    try {
      const [chunk] = await once(supervisor.stdout, "data");
      appPid = Number(chunk.toString().trim());
      const justfile = readFileSync(new URL("../../justfile", import.meta.url), "utf8");
      const start = justfile.indexOf("    kill_tree() {");
      const end = justfile.indexOf("\n    }", start) + "\n    }".length;
      const cleanup = justfile.slice(start, end);
      const cleaner = spawn("bash", ["-c", `${cleanup}\nkill_tree "$1"`, "cleanup", String(supervisor.pid)]);
      let errors = "";
      cleaner.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const [code] = await once(cleaner, "close");
      assert.equal(code, 0, errors);
      assert.throws(() => process.kill(appPid, 0), { code: "ESRCH" });
    } finally {
      supervisor.kill("SIGCONT");
      supervisor.kill("SIGKILL");
      if (appPid) {
        try {
          process.kill(-appPid, "SIGKILL");
        } catch {}
      }
      await closed;
    }
  });
}

test("start cleanup lets dev.mjs finish its IPC shutdown before signalling descendants", {
  timeout: 5000,
}, async () => {
  const sessionCode = `
    process.on('SIGTERM', () => {
      console.log('unexpected-session-signal');
      process.exit(1);
    });
    process.on('message', (message) => {
      if (message.type !== 'stop') return;
      setTimeout(() => {
        console.log('session-closed-gracefully');
        process.disconnect();
      }, 150);
    });
    console.log('ready');
  `;
  const controllerCode = `
    import { spawn } from 'node:child_process';
    import { runDevelopment } from ${JSON.stringify(new URL("./dev.mjs", import.meta.url).href)};
    runDevelopment({
      startSession: () => spawn(process.execPath, ['-e', ${JSON.stringify(sessionCode)}], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }),
    });
  `;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", controllerCode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(controller, "close");
  let output = "";
  controller.stdout.on("data", (chunk) => {
    output += chunk;
  });
  try {
    await once(controller.stdout, "data");
    const justfile = readFileSync(new URL("../../justfile", import.meta.url), "utf8");
    const start = justfile.indexOf("    kill_tree() {");
    const end = justfile.indexOf("\n    }", start) + "\n    }".length;
    const cleanup = justfile.slice(start, end);
    const cleaner = spawn("bash", ["-c", `${cleanup}\nkill_tree "$1"`, "cleanup", String(controller.pid)]);
    const [code] = await once(cleaner, "close");
    assert.equal(code, 0);
    assert.deepEqual(await closed, [0, null]);
    assert.match(output, /\[SIGTERM\].*收到外部停止请求/);
    assert.match(output, /session-closed-gracefully/);
    assert.ok(output.indexOf("session-closed-gracefully") < output.indexOf("开发实例已退出。"));
    assert.doesNotMatch(output, /unexpected-session-signal/);
  } finally {
    controller.kill("SIGKILL");
    await closed;
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} announces external shutdown once and reports completion after cleanup`, async (context) => {
    const state = fixture(context, false);
    state.signals.emit(signal);
    state.signals.emit(signal);
    await Promise.resolve();
    assert.equal(state.output.filter((line) => line.includes("收到外部停止请求")).length, 1);
    assert.ok(state.output[0].includes(`[${signal}]`));
    assert.ok(!state.output.includes("开发实例已退出。"));
    assert.deepEqual(state.children[0].kills, ["SIGTERM"]);
    state.children[0].finish();
    await state.controller.stop();
    assert.equal(state.output.at(-1), "开发实例已退出。");
    assert.equal(state.signals.listenerCount(signal), 0);
  });
}
