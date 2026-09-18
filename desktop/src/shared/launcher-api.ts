import type { SearchHit } from "xiaowei-search";

export type LauncherHit = Omit<SearchHit, "actionType" | "actionValue" | "recencyKey">;
export type LauncherMode = "search" | "clipboard";
export interface SearchResponse {
  token: number;
  hits: LauncherHit[];
}
export interface LauncherApi {
  onOpen?(callback: (mode: LauncherMode) => void): () => void;
  hide(): void;
  resetPosition?(): void;
  search(query: string): Promise<SearchResponse>;
  execute(token: number, id: string): Promise<undefined | "clipboard">;
  resize(resultCount: number, mode?: "clipboard"): void;
  icon(token: number, id: string): Promise<string | null>;
}

export function launcherHeight(resultCount: number): number {
  const rows = Math.min(9, Math.max(0, resultCount));
  return rows === 0 ? 71 : 71 + 17 + rows * 48 + (rows - 1) * 4;
}
