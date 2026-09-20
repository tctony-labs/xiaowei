import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runDevelopment } from "../dev.mjs";
import { stopProcessGroup } from "../dev-process.mjs";

const require = createRequire(import.meta.url);
for (const stubborn of [false, true]) {
  test(`nodemon/pnpm shutdown waits for the entire application group (ignores TERM: ${stubborn})`, {
    timeout: 15000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "xiaowei-dev-group-"));
    const pidFile = join(directory, "application.pid");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { "dev:main": "node app.cjs" } }));
    writeFileSync(
      join(directory, "app.cjs"),
      `
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        process.on('SIGTERM', () => { ${stubborn ? "" : "setTimeout(() => process.exit(0), 150);"} });
        process.on('SIGINT', () => {});
        setInterval(() => {}, 1000);
      `,
    );
    const fd = openSync(join(directory, "output.log"), "w");
    const watcher = spawn(
      process.execPath,
      [
        require.resolve("nodemon/bin/nodemon.js"),
        "--watch",
        join(directory, ".rs"),
        "--signal",
        "SIGTERM",
        "--no-stdin",
        "--exec",
        "pnpm dev:main",
      ],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", fd, fd],
      },
    );
    closeSync(fd);
    const closed = once(watcher, "close");
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(pidFile) && Date.now() < deadline) await delay(25);
      assert.ok(existsSync(pidFile), readFileSync(join(directory, "output.log"), "utf8"));
      const application = Number(readFileSync(pidFile, "utf8"));
      await stopProcessGroup(watcher, closed, 400);
      assert.throws(() => process.kill(application, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(-watcher.pid, 0), { code: "ESRCH" });
    } finally {
      try {
        process.kill(-watcher.pid, "SIGKILL");
      } catch {}
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("two R commands and Ctrl+C stop real Vite/nodemon/pnpm without orphaning applications", {
  timeout: 15000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-dev-restart-"));
  const pidFile = join(directory, "app.pid");
  const groupFile = join(directory, "group.pid");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { "dev:main": "node app.cjs" } }));
  writeFileSync(
    join(directory, "app.cjs"),
    `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {
      console.error('/test/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron exited with signal SIGTERM');
      console.error('Application stopping');
      setTimeout(() => process.exit(0), 100);
    });
    setInterval(() => {}, 1000);
  `,
  );
  writeFileSync(
    join(directory, "session.mjs"),
    `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { createServer } from ${JSON.stringify(import.meta.resolve("vite"))};
    import { runSession } from ${JSON.stringify(new URL("../dev-session.mjs", import.meta.url).href)};
    runSession({
      createRenderer: () => createServer({
        configFile: false, logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: '127.0.0.1', port: 0, watch: null },
      }),
      launchWatcher: () => {
        const child = spawn(process.execPath, [${JSON.stringify(require.resolve("nodemon/bin/nodemon.js"))},
          '--watch', '.rs', '--signal', 'SIGTERM', '--no-stdin', '--exec', 'pnpm dev:main'], {
          detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        writeFileSync(${JSON.stringify(groupFile)}, String(child.pid));
        return child;
      },
    });
  `,
  );
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = [];
  const groups = [];
  const sessions = [];
  let sessionOutput = "";
  const controller = runDevelopment({
    input,
    signals: new EventEmitter(),
    print: (line) => output.push(line),
    startSession: () => {
      const child = spawn(process.execPath, [join(directory, "session.mjs")], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.stdout.on("data", (chunk) => {
        sessionOutput += chunk;
      });
      child.stderr.on("data", (chunk) => {
        sessionOutput += chunk;
      });
      sessions.push(child);
      return child;
    },
  });
  async function application(previous = 0) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      if (pid && pid !== previous) {
        groups.push(Number(readFileSync(groupFile, "utf8")));
        return pid;
      }
      await delay(25);
    }
    assert.fail("test application did not start");
  }
  try {
    let pid = await application();
    for (let i = 0; i < 2; i++) {
      input.write("R");
      await controller.idle();
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      pid = await application(pid);
    }
    input.write("\x03");
    await controller.stop();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    for (const group of groups) assert.throws(() => process.kill(-group, 0), { code: "ESRCH" });
    assert.ok(!output.some((line) => line.includes("失败")), output.join("\n"));
    assert.ok(sessionOutput.includes("Application stopping"), sessionOutput);
    assert.ok(!sessionOutput.includes("exited with signal SIGTERM"), sessionOutput);
    assert.ok(!/ELIFECYCLE.*Command failed\./.test(sessionOutput), sessionOutput);
  } finally {
    for (const group of groups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    for (const child of sessions) child.kill("SIGTERM");
    await controller.stop();
    input.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
