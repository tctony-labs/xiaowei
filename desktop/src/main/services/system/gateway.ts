import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { app, type BrowserWindow, clipboard, shell } from "electron";
import {
  EmptySchema,
  SettingsAnchor,
  SettingsNavigationRequestedSchema,
  System,
  TakeSettingsNavigationResponseSchema,
} from "xiaowei-contracts";
import { bindHandlers, type EventSink } from "xiaowei-gateway";
import type { CallContext, GatewayHost } from "xiaowei-gateway/host";

function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported URL scheme");
  return url.href;
}

async function localPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid local path");
  await access(path);
  return path;
}

export function registerSystem(
  host: GatewayHost,
  windowFor: (context: CallContext) => Pick<BrowserWindow, "hide">,
  openSettings?: () => Promise<Pick<BrowserWindow, "hide">>,
) {
  const pending = new WeakMap<object, SettingsAnchor>();
  const listeners = new Map<object, Set<EventSink>>();

  function deliver(window: object, anchor: SettingsAnchor) {
    pending.set(window, anchor);
    const sinks = listeners.get(window);
    if (!sinks?.size) return;
    const bytes = toBinary(SettingsNavigationRequestedSchema, create(SettingsNavigationRequestedSchema));
    for (const sink of sinks) {
      void Promise.resolve(sink(bytes)).catch((error) => console.error("Settings navigation failed", error));
    }
  }

  return host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        async openSettings(request, _client, context) {
          windowFor(context);
          if (request.anchor !== SettingsAnchor.MODEL_PROVIDERS) throw new Error("Invalid settings anchor");
          if (!openSettings) throw new Error("Settings window unavailable");
          const window = await openSettings();
          deliver(window, request.anchor);
          return create(EmptySchema);
        },
        takeSettingsNavigation(_request, _client, context) {
          const window = windowFor(context);
          const anchor = pending.get(window);
          pending.delete(window);
          return create(TakeSettingsNavigationResponseSchema, { anchor });
        },
        setAutostart(request) {
          const previous = app.getLoginItemSettings().openAtLogin;
          app.setLoginItemSettings({ openAtLogin: request.enabled });
          if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== request.enabled) {
            app.setLoginItemSettings({ openAtLogin: previous });
            throw new Error("Unable to change login item setting");
          }
          return create(EmptySchema);
        },
        hideWindow(_request, _client, context) {
          windowFor(context).hide();
          if (process.platform === "darwin") app.hide();
          return create(EmptySchema);
        },
        writeClipboardText(request) {
          clipboard.writeText(request.text);
          return create(EmptySchema);
        },
        async openPath(request) {
          const error = await shell.openPath(await localPath(request.path));
          if (error) throw new Error(error);
          return create(EmptySchema);
        },
        async revealPath(request) {
          shell.showItemInFolder(await localPath(request.path));
          return create(EmptySchema);
        },
        async openUrl(request) {
          await shell.openExternal(webUrl(request.url));
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
    [
      {
        name: SettingsNavigationRequestedSchema.typeName,
        policy: "coalesce",
        async attach(context, _filter, sink) {
          const window = windowFor(context);
          const sinks = listeners.get(window) ?? new Set<EventSink>();
          sinks.add(sink);
          listeners.set(window, sinks);
          const anchor = pending.get(window);
          if (anchor) deliver(window, anchor);
          return {
            close() {
              sinks.delete(sink);
              if (!sinks.size) listeners.delete(window);
            },
          };
        },
      },
    ],
  );
}
