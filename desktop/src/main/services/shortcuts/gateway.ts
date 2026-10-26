import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { Shortcuts } from "proto-desktop-ts";
import { bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import { type ShortcutConfig, shortcutConfig } from "./shortcuts";

export function registerShortcuts(host: GatewayHost, replace: (config: ShortcutConfig) => void) {
  return host.registerOwner(
    "shortcuts",
    bindHandlers(Shortcuts, {
      apply(request) {
        replace(shortcutConfig(request));
        return create(EmptySchema);
      },
    }),
  );
}
