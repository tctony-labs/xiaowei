const assert = require("node:assert/strict");
const { test } = require("node:test");
const { search, readAppIcon } = require("..");

test("native binding returns structured results and isolates concurrent queries", async () => {
  const [first, second, empty] = await Promise.all([search("1+2"), search("(3+4)*5"), search("")]);
  assert.equal(first[0].actionType, "copyText");
  assert.equal(first[0].actionValue, "3");
  assert.equal(second[0].actionValue, "35");
  assert.deepEqual(empty, []);
  assert.ok(Array.isArray(first[0].ranges));
  await assert.rejects(search("a".repeat(4097)), /too long/);
});

test("icon API returns application PNG bytes", { skip: process.platform !== "darwin" }, async () => {
  const finder = await readAppIcon("/System/Library/CoreServices/Finder.app");
  assert.ok(Buffer.isBuffer(finder));
  assert.deepEqual(finder.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(finder.readUInt32BE(16) > 0);
  assert.ok(finder.readUInt32BE(20) > 0);
  assert.equal(await readAppIcon("/no/such/application.app"), null);
});
