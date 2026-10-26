import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFixture } from "./binding-fixture.mjs";
import { ensureTools } from "./ensure-tools.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const ffi = join(root, "crates/xiaowei-mobile/ffi");

async function run(command, arguments_, options = {}) {
  const result = await execute(command, arguments_, {
    cwd: root,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

const metadata = JSON.parse(await run("cargo", ["metadata", "--format-version", "1", "--no-deps"]));
const target = metadata.target_directory;
const output = join(target, "mobile-bindings");
const generated = join(output, "generated");
await mkdir(generated, { recursive: true });
const tools = await ensureTools();

await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--features", "bindgen"]);
await run("cargo", ["build", "--locked", "-p", "xiaowei-mobile-ffi", "--lib"]);
await run(join(target, "debug/generate-mobile-bindings"), [
  "generate",
  join(target, "debug/libxiaowei_mobile_ffi.dylib"),
  "--language",
  "swift",
  "--language",
  "kotlin",
  "--out-dir",
  generated,
  "--no-format",
]);
const swift = join(output, "swift-smoke");
await run("swiftc", [
  "-swift-version",
  "6",
  "-strict-concurrency=complete",
  "-warnings-as-errors",
  "-parse-as-library",
  "-I",
  generated,
  "-Xcc",
  `-fmodule-map-file=${join(generated, "XiaoweiMobileFFI.modulemap")}`,
  "-L",
  join(target, "debug"),
  "-lxiaowei_mobile_ffi",
  join(generated, "XiaoweiMobile.swift"),
  join(ffi, "tests/swift/Smoke.swift"),
  "-o",
  swift,
]);
const kotlin = join(output, "kotlin-smoke.jar");
const kotlinEnv = { ...process.env, JAVA_HOME: tools.javaHome };
await run(
  tools.kotlinc,
  [
    join(generated, "xiaowei/mobile/xiaowei_mobile_ffi.kt"),
    join(ffi, "tests/kotlin/Smoke.kt"),
    "-classpath",
    tools.classpath,
    "-include-runtime",
    "-d",
    kotlin,
  ],
  { env: kotlinEnv },
);

const fixtureBinary = join(output, "go-fixture");
await run("go", ["build", "-race", "-o", fixtureBinary, "./internal/httpapi/ws/testfixture"], {
  cwd: join(root, "server"),
});
for (const language of ["Swift", "Kotlin"]) {
  const now = Date.now();
  const samples = JSON.parse(
    await run("cargo", [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "xiaowei-mobile",
      "--example",
      "binding-fixtures",
      "--",
      String(now),
    ]),
  );
  const fixture = await createFixture(fixtureBinary, now, samples.business_code);
  const arguments_ = [
    fixture.url,
    ...["valid", "expired", "rotated", "updated", "login", "health", "business", "updated2"].map(
      (key) => Buffer.from(samples[key]).toString("base64"),
    ),
  ];
  try {
    if (language === "Swift") {
      await fixture.run(swift, arguments_, {
        ...process.env,
        DYLD_LIBRARY_PATH: join(target, "debug"),
      });
    } else {
      await fixture.run(
        tools.java,
        [
          `-Djna.library.path=${join(target, "debug")}`,
          "-cp",
          `${kotlin}:${tools.classpath}`,
          "SmokeKt",
          ...arguments_,
        ],
        kotlinEnv,
      );
    }
  } finally {
    await fixture.close();
  }
  console.log(`${language}: HTTP, WS, checkpoints, cancellation and shutdown passed`);
}
