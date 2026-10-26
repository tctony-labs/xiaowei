import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import type { BrowserWindow } from "electron";
import {
  Launcher,
  LauncherQueryRequestSchema,
  ResultRequestSchema,
  Search,
  SearchResultsSchema,
  System,
} from "proto-desktop-ts";
import { bindClient, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { registerSearch } from "../../src/main/services/launcher/gateway";

for (const fails of [false, true]) {
  test(`app dispatch returns and hides before launch ${fails ? "fails" : "succeeds"}`, async () => {
    const host = new GatewayHost();
    const calls: string[] = [];
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const errors = mock.method(console, "error", () => {});
    const search = host.registerOwner(
      "search",
      bindHandlers(
        Search,
        {
          query: () =>
            create(SearchResultsSchema, {
              hits: [
                {
                  id: "orca",
                  title: "Orca",
                  provider: "app",
                  recencyKey: "orca",
                  action: { action: { case: "launchApp", value: "/Applications/Orca.app" } },
                },
              ],
            }),
          recordUsage() {
            calls.push("record");
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
    );
    const system = host.registerOwner(
      "system",
      bindHandlers(
        System,
        {
          async openPath(request) {
            assert.equal(request.path, "/Applications/Orca.app");
            calls.push("open");
            await waiting;
            if (fails) throw new Error("Launch rejected");
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
    );
    const window = {} as BrowserWindow;
    const launcher = registerSearch(host, () => window, {
      development: false,
      platform: "darwin",
      windowGeneration: () => 0,
      async dismiss(target, restore) {
        assert.equal(target, window);
        assert.equal(restore, false);
        calls.push("dismiss");
      },
      async openExternal() {},
      writeText() {},
      async restart() {},
      resetPosition() {},
      modeChanged() {},
      iconUrl: () => "",
      includeChromeBookmarks: async () => false,
    });
    const api = bindClient(Launcher, host.client({ caller: "test", trusted: true }));
    let execution: Promise<unknown> | undefined;
    try {
      const result = await api.query(create(LauncherQueryRequestSchema, { query: "orca" }));
      let returned = false;
      execution = api
        .execute(
          create(ResultRequestSchema, {
            token: result.token,
            id: "orca",
          }),
        )
        .then(() => {
          returned = true;
        });
      await new Promise(setImmediate);
      assert.equal(returned, true, "Execute must acknowledge dispatch while launch is pending");
      assert.deepEqual(calls, ["open", "dismiss"]);

      // A subsequent presentation must survive completion of the old launch.
      launcher.opened(window, "search");
      await api.query(create(LauncherQueryRequestSchema, { query: "next" }));
      finish();
      await new Promise(setImmediate);
      assert.deepEqual(calls, fails ? ["open", "dismiss"] : ["open", "dismiss", "record"]);
      assert.equal(errors.mock.callCount(), fails ? 1 : 0);
    } finally {
      finish();
      await execution?.catch(() => {});
      await new Promise(setImmediate);
      launcher.close();
      system.close();
      search.close();
      errors.mock.restore();
    }
  });
}
