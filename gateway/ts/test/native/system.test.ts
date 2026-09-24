import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  EmptySchema,
  LocalPathRequestSchema,
  OpenUrlRequestSchema,
  SetAutostartRequestSchema,
  System,
  Theme,
  ToggleThemeResponseSchema,
  WriteClipboardTextRequestSchema,
} from "xiaowei-contracts";
import { bindClient, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";

const require = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
const opened: string[] = [];
let fail = false;
const clipboardTexts: string[] = [];
const pathCalls: string[][] = [];
let pathError = "";
let autostart = false;
let rejectAutostart = false;
let appHidden = 0;

mock.module(require.resolve("electron"), {
  exports: {
    app: {
      isPackaged: true,
      hide() {
        appHidden++;
      },
      getLoginItemSettings: () => ({ openAtLogin: autostart }),
      setLoginItemSettings({ openAtLogin }: { openAtLogin: boolean }) {
        if (!rejectAutostart) autostart = openAtLogin;
      },
    },
    clipboard: { writeText: (text: string) => clipboardTexts.push(text) },
    shell: {
      async openPath(path: string) {
        pathCalls.push(["open", path]);
        return pathError;
      },
      showItemInFolder(path: string) {
        pathCalls.push(["reveal", path]);
      },
      async openExternal(url: string) {
        if (fail) throw new Error("Unable to open browser");
        opened.push(url);
      },
    },
  },
});

const { registerSystem } = await import("../../../../desktop/src/main/services/system/gateway.ts");

test("System opens only web URLs without clipboard and coexists with native theme owner", async () => {
  const host = new GatewayHost();
  const theme = host.registerOwner(
    "native-theme",
    bindHandlers(
      System,
      { toggleTheme: () => create(ToggleThemeResponseSchema, { theme: Theme.DARK }) },
      { partial: true },
    ),
  );
  const owner = registerSystem(host, () => ({ hide() {} }));
  const api = bindClient(System, host.client({ caller: "window", trusted: true }));
  try {
    await api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" }));
    await api.openUrl(create(OpenUrlRequestSchema, { url: "http://example.com/path" }));
    assert.deepEqual(opened, ["https://example.com/", "http://example.com/path"]);
    assert.equal((await api.toggleTheme(create(EmptySchema))).theme, Theme.DARK);

    for (const url of [
      "",
      "not a URL",
      "file:///tmp/a",
      "javascript:alert(1)",
      "data:text/html,hi",
      "app://run",
      "x-apple.systempreferences:com.apple.preference.general",
      `https://example.com/${"x".repeat(16384)}`,
    ]) {
      await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url })));
    }
    assert.equal(opened.length, 2);

    fail = true;
    await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" })));
    owner.close();
    await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" })));
    assert.equal((await api.toggleTheme(create(EmptySchema))).theme, Theme.DARK);
  } finally {
    owner.close();
    theme.close();
  }
});

test("System validates local paths, opens files and directories, and propagates host failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-paths-"));
  const file = join(directory, "中文 file.txt");
  await writeFile(file, "test");
  const host = new GatewayHost();
  const owner = registerSystem(host, () => ({ hide() {} }));
  const api = bindClient(System, host.client({ caller: "test", trusted: true }));
  try {
    await api.openPath(create(LocalPathRequestSchema, { path: file }));
    await api.openPath(create(LocalPathRequestSchema, { path: directory }));
    await api.revealPath(create(LocalPathRequestSchema, { path: file }));
    assert.deepEqual(pathCalls, [
      ["open", file],
      ["open", directory],
      ["reveal", file],
    ]);

    for (const path of ["", "relative.txt", "file:///tmp/a", `${file}\0`, join(directory, "missing")]) {
      await assert.rejects(api.openPath(create(LocalPathRequestSchema, { path })));
      await assert.rejects(api.revealPath(create(LocalPathRequestSchema, { path })));
    }
    assert.equal(pathCalls.length, 3);
    pathError = "No associated application";
    await assert.rejects(api.openPath(create(LocalPathRequestSchema, { path: file })));
    assert.equal(pathCalls.length, 4);
    owner.close();
    await assert.rejects(api.revealPath(create(LocalPathRequestSchema, { path: file })));
    assert.equal(pathCalls.length, 4);
  } finally {
    pathError = "";
    owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("System writes plain clipboard text including empty text", async () => {
  const host = new GatewayHost();
  const owner = registerSystem(host, () => ({ hide() {} }));
  const api = bindClient(System, host.client({ caller: "clipboard-resources", trusted: true }));
  try {
    await api.writeClipboardText(create(WriteClipboardTextRequestSchema, { text: "/tmp/中文 file.txt" }));
    await api.writeClipboardText(create(WriteClipboardTextRequestSchema));
    assert.deepEqual(clipboardTexts, ["/tmp/中文 file.txt", ""]);
  } finally {
    owner.close();
  }
});

test("System resolves the caller window and propagates OS startup failure", async () => {
  const host = new GatewayHost();
  let hidden = 0;
  let live = true;
  const owner = registerSystem(host, () => {
    if (!live) throw new Error("Window unavailable");
    return {
      hide() {
        hidden++;
      },
    };
  });
  const api = bindClient(System, host.client({ caller: "system-test", trusted: true }));
  try {
    const before = appHidden;
    await api.hideWindow(create(EmptySchema));
    assert.equal(hidden, 1);
    assert.equal(appHidden - before, process.platform === "darwin" ? 1 : 0);
    live = false;
    await assert.rejects(api.hideWindow(create(EmptySchema)), /handler or transport failed/);
    assert.equal(hidden, 1);
    await api.setAutostart(create(SetAutostartRequestSchema, { enabled: true }));
    assert.equal(autostart, true);
    rejectAutostart = true;
    await assert.rejects(
      api.setAutostart(create(SetAutostartRequestSchema, { enabled: false })),
      /handler or transport failed/,
    );
    assert.equal(autostart, true);
  } finally {
    rejectAutostart = false;
    owner.close();
  }
});
