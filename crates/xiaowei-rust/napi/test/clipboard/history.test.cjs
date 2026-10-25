const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { initializeLogging } = require("../..");
const { open } = require("./setup.cjs");

test("native local history persists across processes and exposes bounded APIs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-clipboard-"));
  let changes = 0;
  const context = await open(directory, () => changes++);
  const { history } = context;
  try {
    const first = await history.addText("本地 history 100%_");
    const again = await history.addText("本地 history 100%_");
    assert.equal(first.id, again.id);
    assert.equal(again.useCount, 1);
    await history.setFavorite(first.id, true);
    const long = "长文本".repeat(4000);
    const item = await history.addText(long);
    assert.equal(item.kind, "largeText");
    assert.equal(item.text.length, 500);
    assert.equal(await history.readText(item.id), long);
    const found = await history.list({ query: "100%_", favoritesOnly: true });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, first.id);
    const output = execFileSync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        require.resolve("tsx"),
        "-e",
        `
      const { open } = require(process.argv[1]);
      open(process.argv[2]).then(async context => {
        const { history } = context;
        const items = await history.list({ favoritesOnly: true });
        console.log(JSON.stringify(items.map(item => ({ id: item.id, favorite: item.favorite }))));
        await context.close();
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `,
        resolve(__dirname, "setup.cjs"),
        directory,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.deepEqual(JSON.parse(output), [{ id: first.id, favorite: true }]);
    await assert.rejects(history.get("../file"), /Invalid clipboard item ID/);
    await assert.rejects(history.readImage(first.id), /not an image/);
    await assert.rejects(history.list({ limit: 101 }), /Invalid clipboard list/);
    await assert.rejects(history.addText(" \n"), /Empty clipboard/);
    assert.equal(await history.clearHistory(), 1);
    assert.equal((await history.list({})).length, 1);
    assert.equal(await history.delete(first.id), true);
    assert.equal(await history.get(first.id), null);
    assert.equal(await history.delete(first.id), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(changes > 0);
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("regular and Agent native libraries install independent log callbacks", async () => {
  const agent = require("xiaowei-agent");
  const delivered = (initialize) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native log timed out")), 2000);
      initialize(true, (entry) => {
        clearTimeout(timeout);
        resolve(entry);
      });
    });
  const [clipboardEntry, searchEntry] = await Promise.all([
    delivered(initializeLogging),
    delivered(agent.initializeLogging),
  ]);
  assert.equal(clipboardEntry.message, "Native logging initialized: xiaowei-rust");
  assert.equal(searchEntry.message, "Native logging initialized: xiaowei-agent");
  for (const entry of [clipboardEntry, searchEntry]) {
    assert.equal(entry.file, "crates/xw-napi-log/src/lib.rs");
    assert.ok(Number.isInteger(entry.line) && entry.line > 0);
  }
});

test("native editing, notes and categories round trip through napi", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-clipboard-edit-"));
  let context = await open(directory);
  const { history } = context;
  try {
    await history.addText("initial");
    const first = await history.addText("initial");
    assert.equal(first.useCount, 1);
    assert.equal(first.updatedAt, first.createdAt);
    const category = await history.saveCategory("工作", "#F5222D");
    await history.setRemark(first.id, "备注关键词");
    await history.setCategory(first.id, category.id);
    assert.equal(
      (await history.list({ categoryId: category.id, query: "备注关键词" }))[0].id,
      first.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const edited = await history.editText(first.id, "changed");
    assert.equal(edited.id, first.id);
    assert.equal(await history.readText(first.id), "changed");
    assert.equal(edited.remark, "备注关键词");
    assert.equal(edited.useCount, first.useCount);
    assert.equal(edited.createdAt, first.createdAt);
    assert.equal(edited.lastUsedAt, first.lastUsedAt);
    assert.ok(edited.updatedAt > first.updatedAt);
    const unchanged = await history.editText(first.id, "changed");
    assert.deepEqual(unchanged, edited);
    await history.saveCategory("归档", "#1677FF", category.id);
    assert.equal((await history.categories())[0].name, "归档");
    await assert.rejects(history.setCategory(first.id, "99999"));
    await assert.rejects(history.list({ categoryId: "invalid" }));
    await assert.rejects(history.saveCategory("", "#ffffff"));
    await assert.rejects(history.editText(first.id, "  "));
    await history.deleteCategory(category.id);
    assert.equal((await history.get(first.id)).categoryId, undefined);
    assert.equal(await history.readText(first.id), "changed");
    await history.setRemark(first.id, "");
    assert.equal((await history.get(first.id)).remark, undefined);

    await history.addText("target");
    await history.addText("target");
    const target = await history.addText("target");
    assert.equal(target.useCount, 2);
    const merged = await history.editText(first.id, "target");
    assert.deepEqual(merged, target);
    assert.deepEqual(await history.get(target.id), target);
    assert.equal(await history.get(first.id), null);
    await context.close();
    context = await open(directory);
    assert.deepEqual(await context.history.get(target.id), target);
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native categories move recently edited names and colors to the front", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-category-order-"));
  let context = await open(directory);
  const { history } = context;
  const ids = async () => (await history.categories()).map((category) => category.id);

  try {
    const first = await history.saveCategory("工作", "#123456");
    const second = await history.saveCategory("生活", "#654321");
    assert.deepEqual(await ids(), [second.id, first.id]);

    // Native saves use the real owner clock; separate the update from the creation millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await history.saveCategory("工作项目", first.color, first.id);
    assert.deepEqual(await ids(), [first.id, second.id]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await history.saveCategory(second.name, "#1677FF", second.id);
    const categories = await history.categories();
    assert.deepEqual(
      categories.map((category) => category.id),
      [second.id, first.id],
    );
    assert.equal(categories[0].color, "#1677FF");
    assert.equal(categories[1].name, "工作项目");

    await context.close();
    context = await open(directory);
    assert.deepEqual(await context.history.categories(), categories);
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
