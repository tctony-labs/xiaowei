import { create } from "@bufbuild/protobuf";
import { EmptySchema, Shortcuts } from "xiaowei-contracts";
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
