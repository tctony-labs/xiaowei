import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { prepareServer, runServerDevelopment } from "./server.mjs";

function configuration(context) {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-server-prepare-"));
  mkdirSync(join(root, "server/config"), { recursive: true });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("missing configuration prints only missing copy commands and never starts Docker", async (context) => {
  const root = configuration(context);
  const output = [];
  let calls = 0;
  const options = { root, print: (line) => output.push(line), run: async () => calls++ };
  await assert.rejects(prepareServer(options), /尚未准备好/);
  assert.ok(output.includes("cp server/config/server.example.yaml server/config/server.yaml"));
  assert.ok(output.includes("cp server/config/.env.example server/config/.env"));
  assert.equal(calls, 0);

  writeFileSync(join(root, "server/config/.env"), "existing configuration");
  output.length = 0;
  await assert.rejects(prepareServer(options));
  assert.ok(!output.some((line) => line.startsWith("cp server/config/.env.example")));
});

test("preparation delegates configuration validation to Docker startup", async (context) => {
  const root = configuration(context);
  writeFileSync(join(root, "server/config/.env"), "");
  writeFileSync(join(root, "server/config/server.yaml"), "");
  const calls = [];
  const options = { root, print: () => {}, run: async (...args) => calls.push(args) };
  await prepareServer(options);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(-5), ["up", "-d", "--wait", "--wait-timeout", "60"]);
  assert.ok(!calls[0][1].includes("--force-recreate"));
  await prepareServer({ ...options, recreate: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[1][1].includes("--force-recreate"));
  assert.ok(calls.every(([, args]) => !args.includes("down") && !args.includes("--renew-anon-volumes")));
});

test("Docker startup failure is propagated without claiming dependencies are ready", async (context) => {
  const root = configuration(context);
  writeFileSync(join(root, "server/config/.env"), "");
  writeFileSync(join(root, "server/config/server.yaml"), "");
  let calls = 0;
  const output = [];
  const failure = new Error("Docker startup failed");
  await assert.rejects(
    prepareServer({
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
  assert.ok(!output.includes("Docker 依赖已就绪。"));
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
    restartDependencies: async () => events.push("docker"),
    stopDependencies: async () => events.push("docker-stop"),
    ...overrides,
  });
  context.after(async () => {
    await controller.stop();
    input.destroy();
  });
  return { input, signals, events, children, output, controller };
}

test("r restarts only Go; R waits for dependencies; commands run in input order", async (context) => {
  let dependenciesReady;
  const state = fixture(context, {
    restartDependencies: () =>
      new Promise((resolve) => {
        state.events.push("docker");
        dependenciesReady = resolve;
      }),
  });
  state.input.write("r");
  await state.controller.idle();
  assert.deepEqual(state.events, ["start", "stop", "start"]);
  state.input.write("Rr");
  await new Promise(setImmediate);
  assert.ok(dependenciesReady);
  assert.deepEqual(state.events.slice(-2), ["stop", "docker"]);
  assert.equal(state.children.length, 2);
  dependenciesReady();
  await state.controller.idle();
  assert.deepEqual(state.events.slice(-5), ["stop", "docker", "start", "stop", "start"]);
  state.input.write("h");
  assert.match(state.output.at(-1), /Ctrl\+C/);
});

test("Ctrl+C cancels dependency startup, restores terminal, and skips queued restarts", async (context) => {
  let dependencySignal;
  const state = fixture(context, {
    restartDependencies: (signal) =>
      new Promise((_resolve, reject) => {
        dependencySignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  state.input.write("Rr");
  await new Promise(setImmediate);
  assert.ok(dependencySignal);
  state.input.write("\x03");
  await state.controller.stop();
  assert.equal(dependencySignal.aborted, true);
  assert.equal(state.children.length, 1);
  assert.equal(state.input.isRaw, false);
  assert.equal(state.signals.listenerCount("SIGTERM"), 0);
  assert.ok(!state.output.some((line) => line.includes("命令失败")));
});

test("failed dependency restart leaves Go stopped and R can retry", async (context) => {
  let attempts = 0;
  const state = fixture(context, {
    restartDependencies: async () => {
      if (++attempts === 1) throw new Error("dependencies unavailable");
    },
  });
  state.input.write("R");
  await state.controller.idle();
  assert.equal(state.children.length, 1);
  assert.match(state.output.at(-1), /dependencies unavailable/);
  state.input.write("R");
  await state.controller.idle();
  assert.equal(state.children.length, 2);
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

test("non-TTY preserves stdin and stops Go then dependencies once on SIGTERM", async (context) => {
  const state = fixture(context, {}, false);
  state.input.write("rRh");
  await state.controller.idle();
  assert.deepEqual(state.events, ["start"]);
  state.signals.emit("SIGTERM");
  state.signals.emit("SIGTERM");
  await state.controller.stop();
  assert.deepEqual(state.events, ["start", "stop", "docker-stop"]);
});

test("Ctrl+C stops Go then dependencies and repeated stop does not run cleanup twice", async (context) => {
  const state = fixture(context);
  state.input.write("\x03");
  await state.controller.stop();
  await state.controller.stop();
  assert.deepEqual(state.events, ["start", "stop", "docker-stop"]);
  assert.equal(state.input.isRaw, false);
  assert.equal(state.signals.exitCode, 0);
});

test("Docker stop failure reports nonzero exit without claiming successful shutdown", async (context) => {
  const state = fixture(context, {
    stopDependencies: async () => {
      throw new Error("Docker stop failed");
    },
  });
  await state.controller.stop();
  assert.deepEqual(state.events, ["start", "stop"]);
  assert.equal(state.signals.exitCode, 1);
  assert.ok(!state.output.some((line) => line.includes("实例已退出")));
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
