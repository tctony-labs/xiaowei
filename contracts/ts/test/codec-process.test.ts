import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodec } from "./codec-process.ts";

test("codec subprocess preserves empty input and large binary output", () => {
  for (const input of [new Uint8Array(), new Uint8Array(2 * 1024 * 1024).fill(197)]) {
    const output = runCodec(process.execPath, input, {
      caseName: "binary round trip",
      args: ["-e", "process.stdin.pipe(process.stdout)"],
    });
    assert.deepEqual(output, input);
  }
});

test("invalid wire requires a normal nonzero exit; success and signals fail the check", () => {
  const input = new Uint8Array([0x80]);
  const reject = ["-e", "process.stderr.write('invalid wire'); process.exit(1)"];
  runCodec(process.execPath, input, { caseName: "invalid wire", args: reject, expectFailure: true });
  assert.throws(
    () => runCodec(process.execPath, input, { caseName: "unexpected failure", args: reject }),
    /unexpected failure:.*unexpected exit code 1; invalid wire/,
  );
  assert.throws(
    () =>
      runCodec(process.execPath, input, {
        caseName: "unexpected success",
        args: ["-e", "process.exit(0)"],
        expectFailure: true,
      }),
    /unexpected success:.*unexpected exit code 0/,
  );
  assert.throws(
    () =>
      runCodec(process.execPath, input, {
        caseName: "signal failure",
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        expectFailure: true,
      }),
    /signal failure:.*signal SIGTERM/,
  );
});

test("stalled codec is killed and timeout cannot pass an invalid-wire check", () => {
  const temp = mkdtempSync(join(tmpdir(), "codec-timeout-"));
  const script = `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;

  try {
    for (const expectFailure of [false, true]) {
      const pidFile = join(temp, `child-${expectFailure}.pid`);
      assert.throws(
        () =>
          runCodec(process.execPath, new Uint8Array(), {
            caseName: "stalled codec",
            args: ["-e", script, pidFile],
            expectFailure,
            timeoutMs: 1000,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /stalled codec:.*0 input bytes.*timed out after 1000ms/);
          assert.equal((error.cause as NodeJS.ErrnoException).code, "ETIMEDOUT");
          return true;
        },
      );
      const childPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(childPid > 0);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("spawn failure cannot pass an invalid-wire check", () => {
  assert.throws(
    () =>
      runCodec(join(import.meta.dirname, "missing-codec"), new Uint8Array([0x80]), {
        caseName: "missing codec",
        expectFailure: true,
      }),
    /missing codec:.*ENOENT/,
  );
});
