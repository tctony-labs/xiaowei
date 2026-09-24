import { ThemeMode } from "xiaowei-contracts";

export function themeValue(mode: ThemeMode): "system" | "light" | "dark" {
  if (mode === ThemeMode.LIGHT) return "light";
  if (mode === ThemeMode.DARK) return "dark";
  return "system";
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = themeValue(mode);
}
