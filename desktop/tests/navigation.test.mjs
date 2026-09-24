import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { restrictNavigation } from "../src/main/windows/navigation.ts";

test("development permits only exact page reloads; production still blocks navigation", () => {
  const url = "http://127.0.0.1:5173/?window=settings&development=true";
  for (const development of [true, false]) {
    let windowOpen;
    const contents = Object.assign(new EventEmitter(), {
      getURL: () => url,
      setWindowOpenHandler: (handler) => {
        windowOpen = handler;
      },
    });
    restrictNavigation(contents, development);
    for (const target of [url, "https://example.com/", `${url}&other=1`, "http://127.0.0.1:5173/elsewhere"]) {
      let prevented = false;
      contents.emit("will-navigate", {
        url: target,
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, !(development && target === url));
    }
    assert.deepEqual(windowOpen(), { action: "deny" });
    let webviewPrevented = false;
    contents.emit("will-attach-webview", {
      preventDefault() {
        webviewPrevented = true;
      },
    });
    assert.equal(webviewPrevented, true);
  }
});
