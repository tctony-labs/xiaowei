import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { forwardOutput } from "../dev-output.mjs";

const electron = "/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const notices = `[ELIFECYCLE] Command failed.\n${electron} exited with signal SIGTERM\n`;

test("stop notices remain visible during normal operation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let result = "";
  output.on("data", (chunk) => {
    result += chunk;
  });
  const lines = forwardOutput(input, output, () => false);
  const closed = once(lines, "close");
  input.end(notices);
  await closed;
  assert.equal(result, notices);
});

test("intentional shutdown filters only expected notices, including split and colored lines", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let result = "";
  let stopping = false;
  output.on("data", (chunk) => {
    result += chunk;
  });
  const lines = forwardOutput(input, output, () => stopping);
  const closed = once(lines, "close");
  input.write("Application starting\n");
  stopping = true;
  input.write("\x1b[31m[ELIFE");
  input.write("CYCLE]\x1b[0m Command failed.\r\n");
  input.write(notices);
  const retained =
    "\x1b[36mApplication stopping\x1b[0m\n[ELIFECYCLE] Command failed with exit code 1.\n" +
    `${electron} exited with signal SIGSEGV\ncleanup failed\n`;
  input.end(retained);
  await closed;
  assert.equal(result, `Application starting\n${retained}`);
});
