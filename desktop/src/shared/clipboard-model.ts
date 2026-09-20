import type { ClipboardCategory as Category, ClipboardItem as Item } from "xiaowei-contracts";
// UI view model; protocol IDs/timestamps are converted once at the page boundary.
export type ClipboardItem = Omit<
  Item,
  "$typeName" | "id" | "categoryId" | "kind" | "previewText" | "createdAtMs" | "lastUsedAtMs" | "previewTruncated"
> & {
  id: string;
  categoryId?: string;
  kind: "text" | "image" | "file";
  text?: string;
  previewTruncated?: boolean;
  createdAt: number;
  lastUsedAt: number;
};
export type ClipboardCategory = Omit<Category, "$typeName" | "id"> & { id: string };

export type ClipboardResourceAction = "open" | "reveal" | "copyPath" | "copyDirectory";
