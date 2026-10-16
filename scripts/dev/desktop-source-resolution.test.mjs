import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build } from "vite";
import storybook from "../../desktop/.storybook/main.ts";

test("desktop bundles Gateway source in all targets; Node source condition resolves TypeScript", async () => {
  process.chdir(fileURLToPath(new URL("../../desktop", import.meta.url)));
  const nodeEntry = execFileSync(
    process.execPath,
    [
      "--conditions=source",
      "--input-type=module",
      "-e",
      "console.log(import.meta.resolve('xiaowei-gateway'))",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(nodeEntry, /gateway\/ts\/src\/index\.ts$/);
  const { config } = await resolveConfig({}, "build", "production");
  for (const target of ["main", "preload", "renderer"]) {
    const result = await build({
      ...config[target],
      logLevel: "silent",
      build: { ...config[target].build, write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const chunks = outputs.filter((entry) => entry.type === "chunk");
    const allowedExternal = new Set([
      "electron",
      ...builtinModules.flatMap((name) => [name, `node:${name}`]),
      "xiaowei-agent",
      "xiaowei-search",
      "xiaowei-clipboard",
      "xiaowei-storage",
      "xiaowei-platform",
    ]);
    const emitted = new Set(outputs.map((entry) => entry.fileName));
    for (const chunk of chunks) {
      assert.equal(chunk.map, null, `${target}: unexpected source map`);
      assert.ok(
        !/sourceMappingURL=/.test(chunk.code),
        `${target}: unexpected source map reference`,
      );
      for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
        assert.ok(
          emitted.has(dependency) || allowedExternal.has(dependency),
          `${target}: unexpected external dependency ${dependency}`,
        );
      }
    }

    assert.ok(!outputs.some((entry) => entry.fileName.endsWith(".map")));
    const modules = outputs
      .filter((entry) => entry.type === "chunk")
      .flatMap((entry) => Object.keys(entry.modules));
    assert.ok(
      modules.some((id) => id.includes("/gateway/ts/src/")),
      `${target} must bundle Gateway source`,
    );
    assert.ok(
      !modules.some((id) => id.includes("/gateway/ts/dist/")),
      `${target} must not consume Gateway dist`,
    );

    if (target === "main") {
      assert.ok(
        chunks.some(
          (chunk) =>
            chunk.isDynamicEntry &&
            Object.keys(chunk.modules).some((id) => id.endsWith("/api/bedrock-converse-stream.js")),
        ),
        "Bedrock implementation must be included in a lazy chunk",
      );
    }

    if (target === "renderer") {
      for (const dependency of ["react", "react-dom", "react-markdown", "remark-gfm"]) {
        assert.ok(
          modules.some((id) => id.includes(`/node_modules/${dependency}/`)),
          `renderer must bundle ${dependency}; it is not shipped as a runtime package`,
        );
      }
    }
  }
  const configWithSource = await storybook.viteFinal({});
  assert.ok(configWithSource.resolve.conditions.includes("source"));
});
