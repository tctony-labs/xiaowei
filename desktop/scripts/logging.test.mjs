import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachRendererLogging, createLoggers } from "../src/main/logging.ts";

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
    for (const [index, color] of ["36", "33", "31"].entries()) {
      assert.ok(output[index].data.join(" ").includes(`${ansiEscape}[${color}m`));
    }
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
