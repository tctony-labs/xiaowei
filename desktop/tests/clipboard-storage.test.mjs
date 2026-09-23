import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clipboardStorageUsage } from "../src/main/clipboard-storage.ts";

test("used space includes the database, WAL and clipboard attachments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xiaowei-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "storage.sqlite");
  const clipboard = join(directory, "clipboard");
  await mkdir(join(clipboard, "images"), { recursive: true });
  await writeFile(database, "database");
  await writeFile(`${database}-wal`, "wal");
  await writeFile(join(clipboard, "images", "image.png"), "image");
  assert.equal(await clipboardStorageUsage(clipboard, database), 16n);
  await rm(join(clipboard, "images", "image.png"));
  assert.equal(await clipboardStorageUsage(clipboard, database), 11n);
});
