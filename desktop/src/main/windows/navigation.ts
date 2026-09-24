import type { WebContents } from "electron";

export function restrictNavigation(contents: WebContents, development: boolean): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    // Vite may fall back to a full reload. Preserve the exact page, including its query.
    if (development && event.url === contents.getURL()) return;
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
