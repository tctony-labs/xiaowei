import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAppIconCache } from "../src/main/app-icon-cache.ts";
import { createIconResources } from "../src/main/icon-resources.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const app = "/Applications/WeChat.app";
const png = Buffer.from("test icon");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "xiaowei-icons-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "app-icons");
}

test("concurrent requests extract once; a fresh cache instance reuses disk without extending TTL", async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const cache = createAppIconCache(directory, async () => {
    calls++;
    return png;
  });
  assert.deepEqual(await Promise.all([cache(app), cache(app)]), [png, png]);
  assert.equal(calls, 1);
  const [name] = await readdir(directory);
  const file = join(directory, name);
  const before = (await stat(file)).mtimeMs;
  const restarted = createAppIconCache(directory, async () => assert.fail("must reuse disk"));
  assert.deepEqual(await restarted(app), png);
  assert.equal((await stat(file)).mtimeMs, before);
});

test("disk entries expire after one week, including in the same running instance", async (t) => {
  const directory = await fixture(t);
  await createAppIconCache(directory, async () => png)(app);
  const [name] = await readdir(directory);
  const old = new Date(Date.now() - WEEK - 1000);
  await utimes(join(directory, name), old, old);
  let calls = 0;
  const cache = createAppIconCache(directory, async () => {
    calls++;
    return png;
  });
  assert.deepEqual(await cache(app), png);
  assert.equal(calls, 1);
  assert.deepEqual(await cache(app), png);
  assert.equal(calls, 1);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + WEEK + 1000 });
  assert.deepEqual(await cache(app), png);
  assert.equal(calls, 2);
});

test("failed extraction is retried and does not create a disk entry", async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const cache = createAppIconCache(directory, async () => {
    calls++;
    if (calls === 1) throw new Error("temporary failure");
    if (calls === 2) return null;
    return png;
  });
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await cache(app), null);
  assert.deepEqual(await cache(app), null);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(await cache(app), png);
  assert.equal(calls, 3);
});

test("unwritable cache still returns the extracted icon and retries extraction on the next request", async (t) => {
  const directory = await fixture(t);
  await writeFile(directory, "blocks directory creation");
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  const cache = createAppIconCache(directory, async () => {
    calls++;
    return png;
  });
  assert.deepEqual(await cache(app), png);
  assert.deepEqual(await cache(app), png);
  assert.equal(calls, 2);
});

test("resource requests reuse disk but re-extract expired icons in the same host", async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const cache = createAppIconCache(directory, async () => {
    calls++;
    return png;
  });
  const icons = createIconResources(async (path) => (await cache(path)) ?? undefined);
  t.after(() => icons.close());
  const url = icons.url(app);
  assert.equal(calls, 0);

  const read = async () => {
    const response = await icons.respond(new Request(url));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  };
  await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  await read();
  assert.equal(calls, 1);

  const [name] = await readdir(directory);
  const old = new Date(Date.now() - WEEK - 1000);
  await utimes(join(directory, name), old, old);
  await read();
  assert.equal(calls, 2);
});
