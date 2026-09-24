import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { BrowserWindow } from "electron";
import {
  ClipboardBiz,
  ClipboardItemRequestSchema,
  ClipboardResourceRequestSchema,
  EmptySchema,
  Launcher,
  LauncherMode,
  LauncherQueryRequestSchema,
  ResultRequestSchema,
  Search,
  SearchHitSchema,
  SearchResultsSchema,
  System,
  Theme,
  ToggleThemeResponseSchema,
  UpdateLayoutRequestSchema,
} from "xiaowei-contracts";
import { bindClient, bindHandlers, createClient } from "xiaowei-gateway";
import { createContext, GatewayHost } from "xiaowei-gateway/host";
import { createIconResources } from "../../../desktop/src/main/resources/app-icons/protocol.js";
import { registerSearch } from "../../../desktop/src/main/services/launcher/gateway.js";
import { createServices } from "../../../desktop/src/renderer/src/services.js";

test("launcher tokens and execution are preserved; search does not read icons", async () => {
  const host = new GatewayHost();
  let slow!: () => void;
  let reads = 0;
  let failOpen = false;
  const icons = createIconResources(async () => {
    reads++;
    return Uint8Array.of(1, 255);
  });
  const actions: unknown[] = [];
  host.registerOwner(
    "search",
    bindHandlers(Search, {
      async query(request) {
        if (request.query === "slow")
          await new Promise<void>((resolve) => {
            slow = resolve;
          });
        return create(SearchResultsSchema, {
          hits: [
            create(SearchHitSchema, {
              id: request.query,
              title: request.query,
              provider: "app",
              recencyKey: "app:test",
              action: { action: { case: "launchApp", value: "/Applications/Test.app" } },
            }),
          ],
        });
      },
      recordUsage(request) {
        actions.push(["usage", request.recencyKey]);
        return create(EmptySchema);
      },
    }),
  );
  host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        openPath: (request, _client, caller) => {
          assert.equal(caller, context);
          if (failOpen) throw new Error("Cannot open application");
          actions.push(request.path);
          return create(EmptySchema);
        },
        toggleTheme: () => create(ToggleThemeResponseSchema, { theme: Theme.DARK }),
      },
      { partial: true },
    ),
  );
  const context = createContext({ caller: "window", trusted: true });
  const window = {
    hide() {
      actions.push("hide");
    },
    setSize(...size: number[]) {
      actions.push(size);
    },
    webContents: {},
    show() {},
    focus() {},
  } as unknown as BrowserWindow;
  const owner = registerSearch(
    host,
    (caller) => {
      if (caller !== context) throw new Error("Window unavailable");
      return window;
    },
    {
      development: true,
      platform: "darwin",
      iconUrl: icons.url,
      includeChromeBookmarks: async () => true,
      async openExternal(url) {
        actions.push(url);
      },
      writeText(text) {
        actions.push(text);
      },
      async restart() {
        actions.push("restart");
      },
      resetPosition() {},
      modeChanged(mode) {
        actions.push(mode);
      },
    },
  );
  const api = bindClient(Launcher, createClient(host.transport(context)));
  const first = api.query(create(LauncherQueryRequestSchema, { query: "slow" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const current = await api.query(create(LauncherQueryRequestSchema, { query: "fast" }));
  slow();
  assert.deepEqual((await first).hits, []);
  assert.equal(reads, 0);
  assert.equal("action" in current.hits[0], false);
  const url = current.hits[0].iconUrl;
  assert.ok(url);
  const [a, b] = await Promise.all([icons.respond(new Request(url)), icons.respond(new Request(url))]);
  assert.deepEqual([...new Uint8Array(await a.arrayBuffer())], [1, 255]);
  assert.equal(b.status, 200);
  assert.equal(reads, 1);
  await assert.rejects(api.execute(create(ResultRequestSchema, { token: current.token - 1, id: "slow" })));
  failOpen = true;
  await assert.rejects(api.execute(create(ResultRequestSchema, { token: current.token, id: "fast" })));
  assert.deepEqual(actions, []);
  failOpen = false;
  await api.execute(create(ResultRequestSchema, { token: current.token, id: "fast" }));
  assert.deepEqual(actions.slice(0, 3), ["/Applications/Test.app", ["usage", "app:test"], "hide"]);
  await api.updateLayout(create(UpdateLayoutRequestSchema, { resultCount: 2, mode: LauncherMode.SEARCH }));
  await api.updateLayout(create(UpdateLayoutRequestSchema, { mode: LauncherMode.CLIPBOARD }));
  assert.deepEqual(actions.slice(-4), ["search", [800, 188], "clipboard", [800, 580]]);
  await assert.rejects(
    bindClient(Launcher, host.client({ caller: "native", trusted: true })).query(
      create(LauncherQueryRequestSchema, { query: "x" }),
    ),
  );
  owner.close();
});

test("service getters are lazy and cache bindings; one service can span owners", async () => {
  const host = new GatewayHost();
  let connections = 0;
  const services = createServices(() => {
    connections++;
    return host.client({ caller: "test", trusted: true });
  });
  assert.equal(connections, 0);
  assert.equal(services.getClipboard(), services.getClipboard());
  assert.equal(services.getLauncher(), services.getLauncher());
  assert.equal(services.getApp(), services.getApp());
  assert.equal(services.getSystem(), services.getSystem());
  assert.equal(services.getKeyValue(), services.getKeyValue());
  assert.equal(connections, 1);
  host.registerOwner("native", bindHandlers(ClipboardBiz, { copy: () => create(EmptySchema) }, { partial: true }));
  host.registerOwner(
    "main",
    bindHandlers(ClipboardBiz, { openResource: () => create(EmptySchema) }, { partial: true }),
  );
  await services.getClipboard().copy(create(ClipboardItemRequestSchema, { id: 1n }));
  await services.getClipboard().openResource(create(ClipboardResourceRequestSchema, { id: 1n }));
  assert.throws(() =>
    host.registerOwner(
      "duplicate",
      bindHandlers(
        ClipboardBiz,
        {
          copy: () => create(EmptySchema),
        },
        { partial: true },
      ),
    ),
  );
});

test("icon failures do not poison the cache; unknown URLs never read files", async () => {
  let reads = 0;
  const icons = createIconResources(async () => {
    reads++;
    return reads === 1 ? undefined : Uint8Array.of(137, 80, 78, 71);
  });
  assert.equal((await icons.respond(new Request("xiaowei-icon://app/unknown"))).status, 404);
  assert.equal(reads, 0);
  const url = icons.url("/Applications/Example.app");
  assert.equal((await icons.respond(new Request(url))).status, 404);
  assert.equal((await icons.respond(new Request(url))).status, 200);
  assert.equal(reads, 2);
  icons.close();
  assert.equal((await icons.respond(new Request(url))).status, 404);
});

test("Launcher web actions use System with original context and preserve failure and scheme rules", async () => {
  const host = new GatewayHost();
  const context = createContext({ caller: "window", trusted: true });
  const actions: string[] = [];
  let url = "https://example.com";
  let provider = "bookmark";
  let fail = false;
  const search = host.registerOwner(
    "search",
    bindHandlers(Search, {
      query: () =>
        create(SearchResultsSchema, {
          hits: [
            {
              id: "url",
              provider,
              recencyKey: "url",
              action: { action: { case: "openUrl", value: url } },
            },
          ],
        }),
      recordUsage: () => {
        actions.push("usage");
        return create(EmptySchema);
      },
    }),
  );
  const system = host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        openUrl: (request, _client, caller) => {
          assert.equal(caller, context);
          if (fail) throw new Error("Browser unavailable");
          actions.push(`system:${request.url}`);
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
  const window = { hide: () => actions.push("hide") } as unknown as BrowserWindow;
  const launcher = registerSearch(host, () => window, {
    development: false,
    platform: "darwin",
    iconUrl: () => "",
    includeChromeBookmarks: async () => true,
    openExternal: async (url) => {
      actions.push(`external:${url}`);
    },
    writeText() {},
    restart: async () => {},
    resetPosition() {},
    modeChanged() {},
  });
  const api = bindClient(Launcher, createClient(host.transport(context)));
  const execute = async () => {
    const { token } = await api.query(create(LauncherQueryRequestSchema, { query: "url" }));
    await api.execute(create(ResultRequestSchema, { token, id: "url" }));
  };
  try {
    await execute();
    assert.deepEqual(actions, ["system:https://example.com/", "usage", "hide"]);
    actions.length = 0;
    fail = true;
    await assert.rejects(execute());
    assert.deepEqual(actions, []);

    url = "x-apple.systempreferences:com.apple.preference.general";
    await assert.rejects(execute());
    provider = "app";
    await execute();
    assert.deepEqual(actions, [`external:${url}`, "usage", "hide"]);
  } finally {
    launcher.close();
    system.close();
    search.close();
  }
});
