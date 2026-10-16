import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

for (const terminalExit of ["SIGHUP", "stdout", "stderr", "EIO", "shutdown-output-EIO"]) {
  test(`terminal ${terminalExit} cleans the detached application group`, {
    timeout: 10000,
  }, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "xiaowei-terminal-"));
    const applicationCode = `
      process.stdout.on('error', () => {});
      process.stderr.on('error', () => {});
      process.on('SIGTERM', () => {
        console.log('application stopping');
        console.error('application stopping');
        setTimeout(() => process.exit(0), 100);
      });
      process.send({ ready: true });
      setInterval(() => {
        process.stdout.write('tick\\n');
        process.stderr.write('tick\\n');
      }, 25);
    `;
    const sessionCode = `
      import { spawn } from 'node:child_process';
      import { runSession } from ${JSON.stringify(new URL("./dev-session.mjs", import.meta.url).href)};
      runSession({
        createRenderer: async () => ({
          listen: async () => {}, close: async () => {}, printUrls() {},
          resolvedUrls: { local: ['test-only'] },
        }),
        launchWatcher: () => {
          const child = spawn(process.execPath, ['-e', ${JSON.stringify(applicationCode)}], {
            detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          child.once('message', () => {
            process.send({ session: process.pid, application: child.pid });
          });
          return child;
        },
      });
      process.on('message', (message) => {
        if (message.type === 'EIO') {
          process.stdout.emit('error', Object.assign(new Error('terminal disconnected'), { code: 'EIO' }));
        }
      });
    `;
    const controllerCode = `
      import { spawn } from 'node:child_process';
      import { runDevelopment } from ${JSON.stringify(new URL("./dev.mjs", import.meta.url).href)};
      runDevelopment({
        startSession: () => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(sessionCode)}], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          });
          child.on('message', (message) => process.send(message));
          process.on('message', (message) => {
            if (message.type === 'shutdown-output-EIO') {
              process.stdout._write = (_chunk, _encoding, callback) => {
                const error = Object.assign(new Error('terminal disconnected'), { code: 'EIO' });
                setImmediate(() => callback(error));
              };
              process.kill(process.pid, 'SIGTERM');
            } else {
              child.send(message);
            }
          });
          return child;
        },
      });
      process.channel.unref();
    `;
    const controller = spawn(process.execPath, ["--input-type=module", "-e", controllerCode], {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = once(controller, "close");
    let state;
    let output = "";
    for (const stream of [controller.stdout, controller.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    context.after(async () => {
      for (const pid of [-controller.pid, state && -state.application]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await closed;
      rmSync(directory, { recursive: true, force: true });
    });

    [state] = await once(controller, "message");
    if (terminalExit === "SIGHUP") process.kill(-controller.pid, "SIGHUP");
    else if (terminalExit.endsWith("EIO")) controller.send({ type: terminalExit });
    else controller[terminalExit].destroy();

    const deadline = Date.now() + 3000;
    while ((alive(state.application) || alive(state.session)) && Date.now() < deadline) {
      await delay(25);
    }
    assert.equal(alive(state.application), false, output);
    assert.equal(alive(state.session), false, output);
    assert.deepEqual(await closed, [0, null], output);
    assert.doesNotMatch(output, /Unhandled 'error'|ERR_IPC_CHANNEL_CLOSED|开发进程退出失败/);
  });
}
