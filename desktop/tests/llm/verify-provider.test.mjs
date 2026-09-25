import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { llmFixture } from "../fixtures/llm.mjs";
import { configDocument } from "../fixtures/model-config.mjs";

const execute = (path, mode, id = "test") =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/verify-llm.mjs", "--model", id, "--mode", mode],
      {
        cwd: new URL("../../", import.meta.url),
        env: { PATH: process.env.PATH, XIAOWEI_LLM_CONFIG: path, VERIFY_KEY: "test-key" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
  test(`${api}: explicit verification command uses only its supplied environment`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    const directory = await mkdtemp(join(tmpdir(), "llm-verify-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "models.json");
    const { apiKey: _key, ...model } = fixture.model;
    await writeFile(path, JSON.stringify(configDocument([{ ...model, apiKeyEnv: "VERIFY_KEY" }])));
    for (const mode of ["complete", "cancel"]) {
      const result = await execute(path, mode);
      assert.equal(result.code, 0, result.output);
      assert.ok(!result.output.includes("test-key"));
    }
    assert.equal((await execute(path, "complete", "missing")).code, 1);
  });
}
