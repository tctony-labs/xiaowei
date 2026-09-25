import type { LauncherHit as Hit } from "xiaowei-contracts";

export type LauncherHit = Omit<Hit, "$typeName" | "ranges"> & {
  ranges: { start: number; end: number }[];
};
export type LauncherMode = "search" | "clipboard" | "quick-chat";
export interface SearchResponse {
  token: number;
  hits: LauncherHit[];
}
export function launcherHeight(resultCount: number): number {
  const rows = Math.min(9, Math.max(0, resultCount));
  return rows === 0 ? 71 : 71 + 17 + rows * 48 + (rows - 1) * 4;
}
