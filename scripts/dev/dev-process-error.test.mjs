import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { stopProcessGroup } from "./dev-process.mjs";

for (const state of ["?E", "Z", "S", "foreign", "mixed", "stuck", "empty", "unavailable"]) {
  test(`Darwin EPERM probe handles ${state} without ignoring live processes`, {
    skip: process.platform !== "darwin",
  }, async (context) => {
    const group = 12345;
    let probes = 0;
    context.mock.method(childProcess, "execFileSync", () => {
      if (state === "unavailable") throw new Error("ps unavailable");
      if (state === "empty") return "";
      if (state === "foreign") return `12346 1 ${group} ${process.getuid() + 1} ?E\n`;
      if (state === "mixed") return `12346 1 ${group} ${process.getuid()} ?E\n12347 1 ${group} 0 S\n`;
      return `12346 1 ${group} ${process.getuid()} ${state === "stuck" ? "?E" : state}\n`;
    });
    syncBuiltinESMExports();
    context.after(() => {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    });
    context.mock.method(console, "warn", () => {});
    context.mock.method(process, "kill", (pid, signal) => {
      assert.equal(pid, -group);
      if (signal === "SIGTERM" || signal === "SIGKILL") return true;
      assert.equal(signal, 0);
      probes++;
      const code = probes === 1 || state === "stuck" ? "EPERM" : "ESRCH";
      throw Object.assign(new Error(`kill ${code}`), { code });
    });
    const result = stopProcessGroup({ pid: group }, Promise.resolve(), state === "stuck" ? -5000 : 5000);
    if (state === "stuck") {
      await assert.rejects(result, /开发应用进程组未退出/);
    } else if (["S", "foreign", "mixed", "unavailable"].includes(state)) {
      await assert.rejects(result, { code: "EPERM" });
    } else {
      await result;
      assert.equal(probes, state === "empty" ? 1 : 2);
    }
  });
}
