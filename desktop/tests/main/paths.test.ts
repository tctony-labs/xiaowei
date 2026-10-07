import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPaths } from "../../src/main/app/paths";
import { emptyConfig, loadConfig, writeConfig } from "../../src/main/services/llm/config";

test("Agent and models default to the shared home without relocating desktop data", () => {
  const appData = join(tmpdir(), "system-app-data");
  const paths = createPaths(appData, {});
  assert.equal(paths.xiaoweiAgentRootDir, join(homedir(), ".xiaowei"));
  assert.equal(paths.models, join(homedir(), ".xiaowei", "models.json"));
  assert.equal(paths.database, join(appData, "com.tctony.xiaowei", "xiaowei", "storage.sqlite"));
  assert.equal(paths.auth, join(appData, "com.tctony.xiaowei", "xiaowei", "auth.json"));
});

test("XIAOWEI_AGENT_HOME selects an independent Agent and model configuration root", () => {
  const appData = join(tmpdir(), "system-app-data");
  const root = join(tmpdir(), "custom-xiaowei-home");
  const paths = createPaths(appData, { XIAOWEI_AGENT_HOME: root });
  assert.equal(paths.xiaoweiAgentRootDir, root);
  assert.equal(paths.models, join(root, "models.json"));
  assert.equal(paths.database, createPaths(appData, {}).database);
  assert.equal(paths.auth, createPaths(appData, {}).auth);
});

test("invalid home overrides fail instead of writing relative to the working directory", () => {
  for (const root of ["", "relative", "~/.xiaowei"]) {
    assert.throws(
      () => createPaths(tmpdir(), { XIAOWEI_AGENT_HOME: root }),
      /XIAOWEI_AGENT_HOME must be an absolute path/,
    );
  }
});

test("model settings read and write the selected home, retaining the explicit file override", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "module-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XIAOWEI_AGENT_HOME: join(root, "custom-home") };
  const paths = createPaths(root, env);
  const initial = await loadConfig(env, paths.models);
  assert.equal(initial.path, paths.models);
  await writeConfig(initial.path, initial.document);
  assert.deepEqual(JSON.parse(await readFile(paths.models, "utf8")), emptyConfig());
  assert.deepEqual((await loadConfig(env, paths.models)).document.providers, []);

  const explicitPath = join(root, "separate-models.json");
  await writeConfig(explicitPath, emptyConfig());
  const explicit = await loadConfig({ ...env, XIAOWEI_LLM_CONFIG: explicitPath }, paths.models);
  assert.equal(explicit.path, explicitPath);
  assert.equal(paths.xiaoweiAgentRootDir, env.XIAOWEI_AGENT_HOME);
});
