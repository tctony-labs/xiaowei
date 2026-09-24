import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachRendererLogging, createLoggers } from "../src/main/app/logging.ts";

for (const mode of ["healthy", "sync", "async"]) {
  test(`console ${mode} writes preserve file logging without uncaught exceptions`, () => {
    const directory = mkdtempSync(join(tmpdir(), "xiaowei-logs-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import { readdirSync, readFileSync } from "node:fs";
            import { join } from "node:path";
            import { Writable } from "node:stream";
            const [mode, directory, moduleUrl] = process.argv.slice(1);
            const output = { stdout: [], stderr: [] };
            for (const name of ["stdout", "stderr"]) {
              const stream = new Writable({
                write(chunk, encoding, callback) {
                  output[name].push(chunk.toString());
                  if (mode === "async") {
                    setImmediate(() => callback(Object.assign(new Error("write EIO"), { code: "EIO" })));
                  } else {
                    callback();
                  }
                },
              });
              if (mode === "sync") {
                stream.write = (chunk) => {
                  output[name].push(chunk.toString());
                  throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
                };
              }
              Object.defineProperty(process, name, { value: stream });
            }
            const { createLoggers } = await import(moduleUrl);
            const { main, renderer } = createLoggers(directory, true);
            let uncaught = 0;
            process.on("uncaughtExceptionMonitor", () => { uncaught++; });
            Object.assign(console, main.functions);
            console.info("stdout-marker");
            main.error("uncaughtException", new Error("original-error-marker"));
            renderer.warn("renderer-marker");
            await new Promise((resolve) => setTimeout(resolve, 30));
            main.info("after-failure-marker");
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.equal(uncaught, 0);
            assert.match(output.stdout.join(""), /stdout-marker/);
            assert.match(output.stderr.join(""), /original-error-marker/);
            const text = readdirSync(directory)
              .map((name) => readFileSync(join(directory, name), "utf8")).join("");
            for (const marker of ["stdout-marker", "original-error-marker", "renderer-marker", "after-failure-marker"]) {
              assert.equal(text.split(marker).length - 1, 1);
            }
            assert.doesNotMatch(text, /write EIO|write EPIPE/);
          `,
          mode,
          directory,
          new URL("../src/main/app/logging.ts", import.meta.url).href,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr || `child exited with signal ${result.signal}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("main and renderer share one file and console output, with rotation", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 17, 10, 30, 45, 123) });
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-logs-"));
  try {
    const { main, renderer } = createLoggers(directory, true);
    const output = [];
    for (const logger of [main, renderer]) {
      logger.transports.console.useStyles = true;
      logger.transports.console.writeFn = ({ message }) => output.push(message);
    }
    main.info("main-marker", { count: 3 });
    const contents = new EventEmitter();
    attachRendererLogging(contents, renderer);
    contents.emit("console-message", {
      level: "warning",
      message: "renderer-marker",
      sourceId: "app.tsx",
      lineNumber: 12,
    });
    contents.emit("preload-error", {}, "preload.cjs", new Error("preload-marker"));
    const text = readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8");
    assert.match(text, /\[main\].*main-marker.*count: 3/);
    assert.match(text, /\[ warn\].*\[renderer\].*renderer-marker.*app.tsx:12/);
    assert.match(text, /Error: preload-marker/);
    assert.equal(output.length, 3);
    const ansiEscape = String.fromCharCode(27);
    for (const [index, color] of ["0", "33", "31"].entries()) {
      const coloredText = output[index].data.join(" ");
      assert.ok(coloredText.startsWith(`${ansiEscape}[${color}m`));
      assert.ok(coloredText.endsWith(`${ansiEscape}[0m`));
      assert.ok(!coloredText.slice(`${ansiEscape}[${color}m`.length, -4).includes(`${ansiEscape}[0m`));
    }
    assert.match(output[0].data[0], /main-marker.*count: 3/);
    assert.match(output[2].data[0], /Error: preload-marker\n\s+at /);
    assert.ok(!text.includes(ansiEscape));
    for (const [index, label] of ["[ info]", "[ warn]", "[error]"].entries()) {
      assert.ok(output[index].data.join(" ").includes(label));
      assert.ok(text.includes(label));
    }
    main.transports.file.maxSize = 1;
    renderer.transports.file.maxSize = 1;
    renderer.info("after-rotation");
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei-10-30-45-123.log"), "utf8"), /main-marker/);
    assert.doesNotMatch(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /main-marker/);
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /after-rotation/);
    main.info("second-rotation");
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei-10-30-45-123-1.log"), "utf8"), /after-rotation/);
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei-10-30-45-123.log"), "utf8"), /main-marker/);
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /second-rotation/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production omits debug from files and terminal", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 17) });
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-logs-"));
  try {
    const { main } = createLoggers(directory, false);
    const output = [];
    main.transports.console.writeFn = ({ message }) => output.push(message);
    main.debug("hidden-marker");
    main.info("visible-marker");
    assert.doesNotMatch(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /hidden-marker/);
    assert.equal(output.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daily files retain 15 local calendar days and clean up on startup and the next day's write", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 17, 23, 59, 59) });
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-logs-"));
  try {
    for (const name of [
      "2026-09-02-xiaowei.log",
      "2026-09-02-xiaowei-12-30-00-001.log",
      "2026-09-02-xiaowei-12-30-00-001-1.log",
      "2026-09-03-xiaowei.log",
      "2026-09-03-xiaowei-12-30-00-001.log",
      "2026-09-02-unrelated.log",
      "xiaowei.log",
    ])
      writeFileSync(join(directory, name), "existing-marker\n");
    mkdirSync(join(directory, "2026-09-01-xiaowei.log"));
    const { main, renderer } = createLoggers(directory, true);
    for (const logger of [main, renderer]) logger.transports.console.writeFn = () => {};
    assert.ok(!readdirSync(directory).some((name) => name.startsWith("2026-09-02-xiaowei")));
    assert.ok(existsSync(join(directory, "2026-09-03-xiaowei.log")));
    main.info("before-midnight");
    context.mock.timers.setTime(new Date(2026, 8, 18, 0, 0, 1).getTime());
    renderer.info("after-midnight");
    assert.ok(!readdirSync(directory).some((name) => name.startsWith("2026-09-03-xiaowei")));
    assert.match(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /before-midnight/);
    assert.doesNotMatch(readFileSync(join(directory, "2026-09-17-xiaowei.log"), "utf8"), /after-midnight/);
    assert.match(readFileSync(join(directory, "2026-09-18-xiaowei.log"), "utf8"), /after-midnight/);
    assert.ok(existsSync(join(directory, "2026-09-02-unrelated.log")));
    assert.ok(existsSync(join(directory, "2026-09-01-xiaowei.log")));
    assert.ok(existsSync(join(directory, "xiaowei.log")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("injected renderer locations are recorded once without the bundle suffix", () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-source-logs-"));
  try {
    const { renderer } = createLoggers(directory, true);
    const output = [];
    renderer.transports.console.writeFn = ({ message }) => output.push(message);
    const contents = new EventEmitter();
    attachRendererLogging(contents, renderer);
    contents.emit("console-message", {
      level: "info",
      message: "[packages/utils/src/index.ts:10] located-marker",
      sourceId: "file:///app.asar/out/renderer/assets/index.js",
      lineNumber: 1,
    });
    const text = readdirSync(directory)
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("");
    assert.equal(text.split("located-marker").length - 1, 1);
    assert.match(text, /\[packages\/utils\/src\/index.ts:10\]/);
    assert.doesNotMatch(text, /app.asar/);
    assert.equal(output.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const forceColor of [undefined, "0", "1"]) {
  test(`piped logs honor FORCE_COLOR=${forceColor} without coloring log files`, () => {
    const directory = mkdtempSync(join(tmpdir(), "xiaowei-log-colors-"));
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    if (forceColor !== undefined) env.FORCE_COLOR = forceColor;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          const { createLoggers } = await import(process.argv[1]);
          const { main, renderer } = createLoggers(process.argv[2], true);
          main.transports.console.level = 'silly';
          main.info('main-color-marker');
          main.debug('debug-color-marker', { count: 3 });
          main.verbose('verbose-color-marker');
          main.silly('silly-color-marker');
          renderer.warn('renderer-color-marker');
        `,
          new URL("../src/main/app/logging.ts", import.meta.url).href,
          directory,
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      for (const output of [result.stdout, result.stderr]) {
        assert.equal(output.includes("\x1b["), forceColor === "1", output);
      }
      if (forceColor === "1") {
        const lines = [...result.stdout.trimEnd().split("\n"), ...result.stderr.trimEnd().split("\n")];
        for (const [index, color] of [0, 90, 90, 90, 33].entries()) {
          assert.ok(lines[index].startsWith(`\x1b[${color}m`));
          assert.ok(lines[index].endsWith("\x1b[0m"));
          assert.ok(!lines[index].slice(`\x1b[${color}m`.length, -4).includes("\x1b[0m"));
        }
        assert.ok(lines[1].includes("debug-color-marker { count: 3 }"));
      }
      const fileLog = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name), "utf8"))
        .join("");
      assert.match(fileLog, /main-color-marker/);
      assert.match(fileLog, /renderer-color-marker/);
      assert.equal(fileLog.includes("\x1b["), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
