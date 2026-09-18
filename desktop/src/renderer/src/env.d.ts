/// <reference types="vite/client" />

import type { ClipboardApi } from "../../shared/clipboard-api";
import type { LauncherApi } from "../../shared/launcher-api";

declare global {
  interface Window {
    launcher: LauncherApi;
    clipboardHistory: ClipboardApi;
  }
}
