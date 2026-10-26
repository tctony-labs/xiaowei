import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildTargets, generateSwift, run, targetDirectory } from "./ios-build.mjs";

const { values } = parseArgs({
  options: {
    "deployment-target": { type: "string" },
    configuration: { type: "string", default: "Debug" },
  },
});
if (!values["deployment-target"]) {
  throw new Error("Pass --deployment-target from the application's build configuration");
}

const target = await targetDirectory();
const output = join(target, "mobile-ios", values.configuration.toLowerCase());
await generateSwift(target, output);
const libraries = await buildTargets(target, values["deployment-target"], values.configuration);
const headers = join(output, "Headers");
await mkdir(headers, { recursive: true });
await copyFile(join(output, "XiaoweiMobileFFI.h"), join(headers, "XiaoweiMobileFFI.h"));
await copyFile(join(output, "XiaoweiMobileFFI.modulemap"), join(headers, "module.modulemap"));

const framework = join(output, "XiaoweiMobileFFI.xcframework");
await rm(framework, { recursive: true, force: true });
await run("xcodebuild", [
  "-create-xcframework",
  ...libraries.flatMap(({ library }) => ["-library", library, "-headers", headers]),
  "-output",
  framework,
]);
console.log(`iOS native package prepared: ${framework}`);
