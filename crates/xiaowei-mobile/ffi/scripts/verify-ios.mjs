import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildTargets, generateSwift, run, targetDirectory } from "./ios-build.mjs";

const target = await targetDirectory();
const generated = join(target, "mobile-bindings/ios-generated");
await generateSwift(target, generated);

// Library verification does not choose the application's minimum supported iOS version.
for (const { sdkPath, swiftTarget, rustTarget, library, env } of await buildTargets(
  target,
  "15.0",
)) {
  const output = join(target, rustTarget, "mobile-swift");
  await mkdir(output, { recursive: true });
  await run(
    "swiftc",
    [
      "-sdk",
      sdkPath,
      "-target",
      swiftTarget,
      "-swift-version",
      "6",
      "-strict-concurrency=complete",
      "-warnings-as-errors",
      "-parse-as-library",
      "-I",
      generated,
      "-Xcc",
      `-fmodule-map-file=${join(generated, "XiaoweiMobileFFI.modulemap")}`,
      "-emit-module",
      "-emit-library",
      "-module-name",
      "XiaoweiMobile",
      "-emit-module-path",
      join(output, "XiaoweiMobile.swiftmodule"),
      join(generated, "XiaoweiMobile.swift"),
      library,
      "-framework",
      "Security",
      "-framework",
      "SystemConfiguration",
      "-Xlinker",
      "-fatal_warnings",
      "-o",
      join(output, "libXiaoweiMobile.dylib"),
    ],
    { env },
  );
  console.log(`${rustTarget}: Rust static library and Swift SDK compilation/link passed`);
}
