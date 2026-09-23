// Import this into an existing development main process through its Node inspector.
// The isolated host, hidden windows and fixture addons never touch product storage.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { attachElectron } from "xiaowei-gateway/electron";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import { Storage } from "xiaowei-storage";

const require = createRequire(import.meta.url);
export async function run(directory) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const nativeDirectory = `${root}gateway/tests/native/search`;
  const filename = (await readdir(nativeDirectory)).find((name) => name.endsWith(".node"));
  const native = require(`${nativeDirectory}/${filename}`).createGatewayFixture();
  const host = new GatewayHost();
  const endpoint = await attachNative(host, "fixture", native);
  const adapter = attachElectron(host, {
    handle(_channel, handler) {
      ipcMain.handle("xiaowei:gateway:acceptance", handler);
    },
    removeHandler() {
      ipcMain.removeHandler("xiaowei:gateway:acceptance");
    },
  });

  const renderer = await readFile(`${directory}/renderer.js`, "utf8");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(renderer).toString("base64")}`;
  const windows = [];

  const makeWindow = async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: `${directory}/preload.cjs`,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: `gateway-acceptance-${Date.now()}-${windows.length}`,
      },
    });
    windows.push(window);
    adapter.register(window.webContents);
    await window.loadURL("data:text/html,<title>Gateway acceptance</title>");
    await window.webContents.executeJavaScript(`(async () => {
      globalThis.api = (await import(${JSON.stringify(moduleUrl)})).client(window.gateway);
    })()`);
    return window;
  };

  const waitIdle = async () => {
    for (let i = 0; i < 100 && JSON.parse(native.fixtureStreamUsage()).active; i++) await delay(5);
    assert.equal(JSON.parse(native.fixtureStreamUsage()).active, 0);
  };

  const storageDirectory = await mkdtemp(join(tmpdir(), "gateway-storage-acceptance-"));
  let storageOwner;
  try {
    const storage = await Storage.open(join(storageDirectory, "storage.sqlite"));
    storageOwner = await attachNative(host, "storage", storage.createKeyValueGatewayEndpoint());
    const a = await makeWindow();
    const b = await makeWindow();
    const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
    assert.deepEqual(await evaluate(a, "Object.keys(window.gateway)"), ["request", "listen"]);
    assert.equal(await evaluate(a, "typeof window.require"), "undefined");
    assert.deepEqual(await evaluate(a, "api.echo()"), { id: "18446744073709551615", bytes: [0, 255] });

    assert.deepEqual(await evaluate(a, "api.storage()"), { json: '{"enabled":true}' });

    await storageOwner.close();
    const reopened = await Storage.open(join(storageDirectory, "storage.sqlite"));
    storageOwner = await attachNative(host, "storage", reopened.createKeyValueGatewayEndpoint());
    assert.deepEqual(await evaluate(b, "api.storage(false)"), { json: '{"enabled":true}' });

    await evaluate(
      a,
      `(async () => {
        globalThis.events = 0;
        globalThis.subscription = await api.subscribe(() => events++);
      })()`,
    );
    await evaluate(b, "globalThis.events = 0");
    await native.fixturePublish(Buffer.alloc(0));
    await delay(20);
    assert.equal(await evaluate(a, "events"), 1);
    assert.equal(await evaluate(b, "events"), 0);

    await evaluate(
      a,
      `(async () => {
      globalThis.stream = await api.stream('chunks');
    })()`,
    );
    assert.equal(JSON.parse(native.fixtureStreamUsage()).polls, 0);
    assert.equal(await evaluate(a, "stream.next().then(x => String(x.value.value.id))"), "0");
    await delay(20);
    assert.equal(JSON.parse(native.fixtureStreamUsage()).polls, 1);
    await evaluate(a, "stream.cancel()");
    await waitIdle();

    await evaluate(
      a,
      `(async () => {
        globalThis.stream = await api.stream('wait');
        globalThis.pending = stream.next().then(() => 'ok', e => e.message);
      })()`,
    );
    await evaluate(a, "stream.cancel()");
    assert.match(await evaluate(a, "pending"), /cancelled/);
    await waitIdle();

    await evaluate(a, "globalThis.opening = api.stream('openwait').catch(() => undefined); void 0");
    await delay(10);
    await a.loadURL("data:text/html,<title>Reloaded</title>");
    await waitIdle();
    await native.fixturePublish(Buffer.alloc(0));
    await evaluate(
      b,
      `(async () => {
        globalThis.stream = await api.stream('wait');
        globalThis.pending = stream.next().catch(() => undefined);
      })()`,
    );
    await delay(10);
    b.destroy();
    await waitIdle();

    return {
      passed: true,
      checks: [
        "contextBridge ordinary transport",
        "Node isolation",
        "PB bytes/uint64",
        "typed renderer KeyValue against temporary Storage",
        "KeyValue persistence after closing and reopening Storage",
        "two-frame event targeting",
        "native pull without prefetch",
        "pending next cancellation",
        "navigation during open",
        "window destruction releases native producer",
      ],
    };
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    adapter.close();
    await endpoint.close();
    await storageOwner?.close();
    await rm(storageDirectory, { recursive: true, force: true });
  }
}
