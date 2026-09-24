import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

async function fileSize(path: string): Promise<bigint> {
  try {
    const info = await lstat(path);
    return info.isFile() ? BigInt(info.size) : 0n;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0n;
    throw error;
  }
}

async function directorySize(path: string): Promise<bigint> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0n;
    throw error;
  }
  let total = 0n;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += await fileSize(child);
  }
  return total;
}

export async function clipboardStorageUsage(directory: string, databasePath: string): Promise<bigint> {
  const sizes = await Promise.all([
    fileSize(databasePath),
    fileSize(`${databasePath}-wal`),
    fileSize(`${databasePath}-shm`),
    directorySize(directory),
  ]);
  return sizes.reduce((sum, size) => sum + size, 0n);
}
