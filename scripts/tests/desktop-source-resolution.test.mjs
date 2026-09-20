import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build } from "vite";
import storybook from "../../desktop/.storybook/main.ts";

test("desktop bundles Gateway source in all targets; plain Node keeps the dist entry", async () => {
  process.chdir(fileURLToPath(new URL("../../desktop", import.meta.url)));
  const nodeEntry = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "console.log(import.meta.resolve('xiaowei-gateway'))"],
    { encoding: "utf8" },
  ).trim();
  assert.match(nodeEntry, /gateway\/ts\/dist\/index\.js$/);
  const { config } = await resolveConfig({}, "build", "production");
  for (const target of ["main", "preload", "renderer"]) {
    const result = await build({
      ...config[target],
      logLevel: "silent",
      build: { ...config[target].build, write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const modules = outputs.filter((entry) => entry.type === "chunk").flatMap((entry) => Object.keys(entry.modules));
    assert.ok(
      modules.some((id) => id.includes("/gateway/ts/src/")),
      `${target} must bundle Gateway source`,
    );
    assert.ok(!modules.some((id) => id.includes("/gateway/ts/dist/")), `${target} must not consume Gateway dist`);
  }
  const configWithSource = await storybook.viteFinal({});
  assert.ok(configWithSource.resolve.conditions.includes("source"));
});
