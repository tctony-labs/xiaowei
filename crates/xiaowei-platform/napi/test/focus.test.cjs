const assert = require("node:assert/strict");
const { test } = require("node:test");
const { captureFocus, frontmostProcess } = require("..");

test("focus capture is explicit and released snapshots cannot restore focus", async () => {
  const pid = frontmostProcess();
  assert.ok(pid === null || (Number.isInteger(pid) && pid > 0));
  const first = await captureFocus();
  const second = await captureFocus();
  if (first) {
    first.release();
    first.release();
    await assert.rejects(first.restore(process.pid), /released/);
    await assert.rejects(first.isFrontmost(), /released/);
  }
  if (second) {
    assert.ok(second.processId > 0);
    assert.equal(typeof (await second.isFrontmost()), "boolean");
    second.release();
  }
});
