import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

// Internal content reader; filesystem paths remain on the backend.
interface ClipboardContentReader {
  get(id: string): Promise<{ kind: string; paths: string[]; imagePath?: string } | null>;
  readText(id: string): Promise<string>;
}

export function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported URL scheme");
  return url.href;
}

// Electron's external viewers require a file; Rust remains the source of clipboard content.
export async function clipboardPaths(
  history: ClipboardContentReader,
  directory: string,
  id: string,
  index?: number,
): Promise<string[]> {
  const item = await history.get(id);
  if (!item) throw new Error("Clipboard item no longer exists");
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error("Invalid file index");
  if (item.kind === "file") {
    const paths = index === undefined ? item.paths : item.paths.slice(index, index + 1);
    if (!paths.length || paths.some((path) => !isAbsolute(path) || path.includes("\0"))) {
      throw new Error("Invalid clipboard file path");
    }
    return paths;
  }
  if (index !== undefined) throw new Error("Not a file record");
  if (item.kind === "image") {
    if (!item.imagePath || !isAbsolute(item.imagePath)) throw new Error("Missing clipboard image path");
    return [item.imagePath];
  }
  if (item.kind !== "largeText" && item.kind !== "text") throw new Error("Unsupported clipboard type");
  const bytes = Buffer.from(await history.readText(id), "utf8");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, `${hash}.txt`);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return [path];
}

export function clipboardPathText(paths: string[], directory: boolean): string {
  const values = directory ? [...new Set(paths.map((path) => dirname(path)))] : paths;
  return values.join("\n");
}
