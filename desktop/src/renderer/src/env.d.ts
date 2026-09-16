/// <reference types="vite/client" />
import type { LauncherApi } from "../../shared/launcher-api";

declare global {
  interface Window {
    launcher: LauncherApi;
  }
}
