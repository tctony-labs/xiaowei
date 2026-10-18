import { execFileSync } from "node:child_process";

export function nativeUuid(path, architecture = process.arch) {
  const expectedArchitecture = architecture === "x64" ? "x86_64" : architecture;
  const output = execFileSync("xcrun", ["dwarfdump", "--uuid", path], { encoding: "utf8" });
  const entries = [...output.matchAll(/UUID: ([\dA-F-]+) \(([^)]+)\)/gi)];
  if (entries.length !== 1 || entries[0][2] !== expectedArchitecture) {
    throw new Error(`Expected one ${architecture} UUID: ${path}`);
  }
  return entries[0][1].toUpperCase();
}

export function verifyNativeSymbols(binary, dsym, architecture = process.arch) {
  const uuid = nativeUuid(binary, architecture);
  if (nativeUuid(dsym, architecture) !== uuid) {
    throw new Error(`dSYM UUID mismatch: ${binary}`);
  }
  return uuid;
}
