import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function createAppIconCache(directory: string, extract: (path: string) => Promise<Buffer | null>) {
  const pending = new Map<string, Promise<string | null>>();

  async function load(path: string): Promise<string | null> {
    const file = join(directory, `${createHash("sha256").update(path).digest("hex")}.png`);
    let png: Buffer | null = null;
    try {
      const info = await stat(file);
      const expiresAt = info.mtimeMs + MAX_AGE;
      if (expiresAt > Date.now()) png = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Application icon cache read failed", error);
      }
    }
    if (!png?.length) {
      png = await extract(path);
      if (!png?.length) return null;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(file, png);
      } catch (error) {
        console.warn("Application icon cache write failed", error);
      }
    }
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  return function getIcon(path: string): Promise<string | null> {
    const inflight = pending.get(path);
    if (inflight) return inflight;
    const request = load(path)
      .catch((error: unknown) => {
        console.warn("Application icon unavailable", error);
        return null;
      })
      .finally(() => pending.delete(path));
    pending.set(path, request);
    return request;
  };
}
