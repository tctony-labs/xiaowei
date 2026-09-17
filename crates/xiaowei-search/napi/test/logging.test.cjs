const assert = require("node:assert/strict");
const { test } = require("node:test");
const { initializeLogging } = require("../index.js");

test("native logs cross the callback bridge and initialization can replace the sink", async () => {
  for (const development of [true, false]) {
    const entry = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native log callback timed out")), 2000);
      initializeLogging(development, (entry) => {
        clearTimeout(timeout);
        resolve(entry);
      });
    });
    assert.equal(entry.level, "info");
    assert.match(entry.target, /^xiaowei_search_napi/);
    assert.equal(entry.message, "Native logging initialized");
  }
});
