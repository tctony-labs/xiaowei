import { BrowserWindow } from "electron";
import { captureFocus, frontmostProcess } from "xiaowei-platform";
import { createFocusSession, type FocusTarget } from "./focus-session";

export function createSystemFocus() {
  return createFocusSession({
    ownProcess: process.pid,
    frontmostProcess: () => frontmostProcess() ?? undefined,
    async capture(): Promise<FocusTarget | undefined> {
      const local = BrowserWindow.getFocusedWindow();
      if (local && frontmostProcess() === process.pid) {
        return {
          processId: process.pid,
          async restore() {
            if (local.isDestroyed() || !local.isVisible()) return false;
            if (local.isMinimized()) local.restore();
            local.show();
            local.focus();
            return true;
          },
          async isFrontmost() {
            return !local.isDestroyed() && local.isFocused();
          },
          release() {},
        };
      }
      const snapshot = await captureFocus();
      if (snapshot?.processId === process.pid) {
        snapshot.release();
        return undefined;
      }
      if (!snapshot) return undefined;
      return {
        processId: snapshot.processId,
        restore: () => snapshot.restore(process.pid),
        isFrontmost: () => snapshot.isFrontmost(),
        release: () => snapshot.release(),
      };
    },
  });
}
