// ---------------------------------------------------------------------------
// Extension → icon type mapping
// ---------------------------------------------------------------------------

export type FileIconType = "default" | "markdown" | "pdf" | "word" | "log" | "image";

const EXT_ICON_MAP: Record<string, FileIconType> = {
  md: "markdown",
  markdown: "markdown",
  pdf: "pdf",
  doc: "word",
  docx: "word",
  log: "log",
  txt: "default",
  webp: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  bmp: "image",
  gif: "image",
};

export const FILE_ICON_COLORS: Record<FileIconType, string> = {
  default: "#00C572",
  markdown: "#3883F3",
  pdf: "#E5484D",
  word: "#2B6CB0",
  log: "#8E8E93",
  image: "#00C572",
};

export function getFileIconType(filePath: string): FileIconType {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_ICON_MAP[ext] ?? "default";
}
