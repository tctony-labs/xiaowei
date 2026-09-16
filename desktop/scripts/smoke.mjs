import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow, nativeTheme } from "electron";

const timeout = setTimeout(() => {
  console.error("Desktop smoke test timed out");
  app.exit(1);
}, 20_000);

app.once("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      const nodeType = await window.webContents.executeJavaScript("typeof window.require");
      assert.equal(nodeType, "undefined");
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("Renderer did not mount")); }, 5000);
        const poll = setInterval(() => {
          const image = document.querySelector("img");
          if (document.querySelector("h1")?.textContent === "XiaoWei" && image?.complete && image.naturalWidth > 0) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(true);
          }
        }, 50);
      })`);
      await mkdir("out/smoke", { recursive: true });
      for (const theme of ["light", "dark"]) {
        nativeTheme.themeSource = theme;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const image = await window.webContents.capturePage();
        await writeFile(`out/smoke/${theme}.png`, image.toPNG());
      }
      console.log("PASS: Node isolation, window rendering, logo loading");
      clearTimeout(timeout);
      for (const openWindow of BrowserWindow.getAllWindows()) openWindow.close();
      app.quit();
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});

await import("../out/main/index.js");
