import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

for (const signal of ["SIGTERM", 0]) {
  test(`session closes real Vite and exits on process group EPERM during ${signal}`, {
    timeout: 10000,
  }, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "xiaowei-session-error-"));
    const source = `
      import { execFileSync } from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      import { createServer } from ${JSON.stringify(import.meta.resolve("vite"))};
      import { runSession } from ${JSON.stringify(new URL("./dev-session.mjs", import.meta.url).href)};

      const watcher = new EventEmitter();
      watcher.pid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
        encoding: 'utf8',
      }));
      watcher.stdout = new PassThrough();
      watcher.stderr = new PassThrough();
      const handle = setInterval(() => {}, 1000);
      watcher.unref = () => handle.unref();
      process.kill = (pid, signal) => {
        if (signal === ${JSON.stringify(signal)}) {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        }
        return true;
      };

      const session = runSession({
        createRenderer: () => createServer({
          configFile: false,
          logLevel: 'silent',
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { host: '127.0.0.1', port: 0, watch: null },
        }),
        launchWatcher: () => watcher,
      });
      await session.ready;
      await session.stop();
      console.log('pipes released:', watcher.stdout.destroyed && watcher.stderr.destroyed);
      console.log('cleanup completed');
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    context.after(async () => {
      child.kill("SIGKILL");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    assert.deepEqual(await closed, [1, null], output);
    output = stripVTControlCharacters(output);
    assert.match(output, /kill EPERM/);
    assert.ok(output.includes(`signal=${signal}`), output);
    assert.match(output, /Process group snapshot/);
    assert.match(output, /cleanup completed/);
    assert.match(output, /pipes released: true/);
  });
}
