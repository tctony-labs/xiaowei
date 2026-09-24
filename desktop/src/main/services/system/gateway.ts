import { create } from "@bufbuild/protobuf";
import { shell } from "electron";
import { EmptySchema, System } from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";

function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported URL scheme");
  return url.href;
}

export function registerSystem(host: GatewayHost) {
  return host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        async openUrl(request) {
          await shell.openExternal(webUrl(request.url));
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
}
