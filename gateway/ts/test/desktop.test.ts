import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { BrowserWindow } from "electron";
import {
  Clipboard,
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
import { createIconResources } from "../../../desktop/src/main/icon-resources.js";
import { registerSearch } from "../../../desktop/src/main/search.js";
import { createServices } from "../../../desktop/src/renderer/src/services.js";

test("launcher tokens and execution are preserved; search does not read icons", async () => {
  const host = new GatewayHost();
  let slow!: () => void;
  let reads = 0;
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
      async openPath(path) {
        actions.push(path);
        return "";
      },
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
  assert.equal(connections, 1);
  host.registerOwner("native", bindHandlers(Clipboard, { copy: () => create(EmptySchema) }, { partial: true }));
  host.registerOwner("main", bindHandlers(Clipboard, { openResource: () => create(EmptySchema) }, { partial: true }));
  await services.getClipboard().copy(create(ClipboardItemRequestSchema, { id: 1n }));
  await services.getClipboard().openResource(create(ClipboardResourceRequestSchema, { id: 1n }));
  assert.throws(() =>
    host.registerOwner(
      "duplicate",
      bindHandlers(
        Clipboard,
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
