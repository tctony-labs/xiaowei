const assert = require("node:assert/strict");
const { test } = require("node:test");
const { initializeLogging, initializeSearch, search } = require("..");

test("startup warmup and early searches share one index initialization", async () => {
  const entries = [];
  let timeout;
  const initialized = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Index initialization timed out")), 15000);
    initializeLogging(true, (entry) => {
      entries.push(entry.message);
      if (entry.message.startsWith("Search index initialized in ")) resolve();
    });
  });
  try {
    assert.deepEqual(await search("  "), []);
    assert.ok(!entries.some((message) => message.startsWith("Search index init")));
    const [, , results] = await Promise.all([initializeSearch(), initializeSearch(), search("1+2"), initialized]);
    assert.equal(results[0].actionValue, "3");
    await initializeSearch();
    assert.equal(entries.filter((message) => message === "Search index initialization started").length, 1);
    assert.equal(entries.filter((message) => message.startsWith("Search index initialized in ")).length, 1);
  } finally {
    clearTimeout(timeout);
  }
});
