import type { ClipboardCategory, ClipboardItem, ClipboardListOptions } from "xiaowei-clipboard";

export type { ClipboardCategory, ClipboardItem, ClipboardListOptions };

export type ClipboardResourceAction = "open" | "reveal" | "copyPath" | "copyDirectory";

export interface ClipboardApi {
  resource(id: string, action: ClipboardResourceAction, index?: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  categories(): Promise<ClipboardCategory[]>;
  saveCategory(name: string, color: string, id?: string): Promise<ClipboardCategory>;
  deleteCategory(id: string): Promise<void>;
  setRemark(id: string, remark: string): Promise<void>;
  setCategory(id: string, categoryId?: string): Promise<void>;
  editText(id: string, text: string): Promise<ClipboardItem>;
  list(options?: ClipboardListOptions): Promise<ClipboardItem[]>;
  get(id: string): Promise<ClipboardItem | null>;
  readText(id: string): Promise<string>;
  readImage(id: string): Promise<Uint8Array>;
  copy(id: string): Promise<void>;
  setFavorite(id: string, favorite: boolean): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  clearHistory(): Promise<number>;
  onChanged(callback: () => void): () => void;
}
