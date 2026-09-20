import { mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { app, clipboard, shell } from "electron";
import { ClipboardHistory } from "xiaowei-clipboard";
import { Clipboard, EmptySchema, System } from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import { clipboardPaths, clipboardPathText, webUrl } from "./clipboard-files";

export async function registerClipboard(host: GatewayHost, directory: string) {
  const exportDirectory = mkdtempSync(join(app.getPath("temp"), "xiaowei-clipboard-"));
  // Legacy callback remains available to existing napi consumers; Gateway publishes from the same Service.
  let history: ClipboardHistory | undefined;
  let native: Awaited<ReturnType<typeof attachNative>> | undefined;
  let owner: ReturnType<GatewayHost["registerOwner"]> | undefined;
  try {
    history = await ClipboardHistory.open(directory, () => {});
    native = await attachNative(host, "clipboard", history.createGatewayEndpoint());
    await history.initialize();
    const content = history;
    const resolve = async (id: bigint, index?: number) => {
      if (id <= 0n || id > 0x7fffffffffffffffn) throw new Error("Invalid clipboard item ID");
      return clipboardPaths(content, exportDirectory, String(id), index);
    };
    owner = host.registerOwner("clipboard-resources", [
      ...bindHandlers(
        System,
        {
          async openUrl(request) {
            await shell.openExternal(webUrl(request.url));
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
      ...bindHandlers(
        Clipboard,
        {
          async openResource(request) {
            const paths = await resolve(request.id, request.index);
            if (paths.length !== 1) throw new Error("Select a single file to open");
            await access(paths[0]);
            const error = await shell.openPath(paths[0]);
            if (error) throw new Error(error);
            return create(EmptySchema);
          },
          async revealResource(request) {
            for (const path of await resolve(request.id, request.index)) {
              await access(path);
              shell.showItemInFolder(path);
            }
            return create(EmptySchema);
          },
          async copyResourcePath(request) {
            const paths = await resolve(request.id, request.index);
            clipboard.writeText(clipboardPathText(paths, request.directory));
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
    ]);
    if (process.platform === "darwin") await history.startMonitoring();
    console.info("Clipboard history ready");
  } catch (error) {
    await history?.stopMonitoring();
    owner?.close();
    try {
      await native?.close();
    } finally {
      rmSync(exportDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    async close() {
      await history?.stopMonitoring();
      owner?.close();
      try {
        await native?.close();
      } finally {
        rmSync(exportDirectory, { recursive: true, force: true });
      }
    },
  };
}
