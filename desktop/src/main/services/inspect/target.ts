import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { InspectError, type InspectSource } from "./protocol.ts";

export async function resolveInspectSource(source: InspectSource): Promise<InspectSource> {
  if (!isAbsolute(source.path)) {
    throw new InspectError("INVALID_SOURCE", "Inspect source must be an absolute path");
  }
  return { kind: source.kind, path: await realpath(source.path) };
}

export function inspectSocketPath(source: InspectSource, uid = process.getuid?.()): string {
  if (uid === undefined) {
    throw new InspectError("UNSUPPORTED_PLATFORM", "Inspect requires Unix sockets");
  }
  const hash = createHash("sha256").update(`${source.kind}\0${source.path}`).digest("hex");
  return join("/tmp", `xiaowei-${uid}`, `${hash}.sock`);
}

export async function ensureInspectDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new InspectError("UNSAFE_SOCKET", "Inspect directory must be private and owned");
  }
}
