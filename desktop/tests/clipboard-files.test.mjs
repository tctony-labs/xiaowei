import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clipboardPaths, clipboardPathText, webUrl } from "../src/main/clipboard-files.ts";

test("text viewer tracks edits; image actions use the original persistent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xw-viewer-test-"));
  let text = "长文本\n".repeat(10000);
  const png = Buffer.from([137, 80, 78, 71]);
  const imagePath = join(directory, "original.png");
  await writeFile(imagePath, png);
  const history = {
    get: async (id) => ({ kind: id === "image" ? "image" : "largeText", imagePath }),
    readText: async () => text,
  };
  try {
    const [first] = await clipboardPaths(history, directory, "text");
    assert.equal(await readFile(first, "utf8"), text);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    text = "编辑后的全文";
    const [second] = await clipboardPaths(history, directory, "text");
    assert.notEqual(first, second);
    assert.equal(await readFile(second, "utf8"), text);
    const [image] = await clipboardPaths(history, directory, "image");
    assert.equal(image, imagePath);
    assert.deepEqual(await readFile(image), png);
    const outputs = await Promise.all(Array.from({ length: 4 }, () => clipboardPaths(history, directory, "image")));
    assert.ok(outputs.every(([path]) => path === image));
    assert.deepEqual(await readFile(image), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file actions resolve only paths from the selected stored record", async () => {
  const paths = ["/tmp/中文,a.pdf", "/tmp/b.txt"];
  const history = { get: async () => ({ kind: "file", paths }) };
  assert.deepEqual(await clipboardPaths(history, "unused", "1"), paths);
  assert.deepEqual(await clipboardPaths(history, "unused", "1", 1), [paths[1]]);
  await assert.rejects(clipboardPaths(history, "unused", "1", 2));
  await assert.rejects(clipboardPaths(history, "unused", "1", -1));
  await assert.rejects(clipboardPaths({ get: async () => null }, "unused", "1"));
  assert.equal(clipboardPathText(paths, false), paths.join("\n"));
  assert.equal(clipboardPathText(paths, true), "/tmp");
});

test("Markdown links allow web URLs and reject executable or local schemes", () => {
  assert.equal(webUrl("https://example.com/path"), "https://example.com/path");
  for (const value of ["file:///tmp/a", "javascript:alert(1)", "data:text/html,hi", "app://run", 42]) {
    assert.throws(() => webUrl(value));
  }
});
