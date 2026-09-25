import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  configureModels,
  invalidConfig,
  type ModelConfig,
  type ResolvedModelConfig,
  validateModel,
} from "./shared/models";

export function resolveModels(entries: readonly ModelConfig[], env: Readonly<Record<string, string | undefined>>) {
  if (!Array.isArray(entries)) invalidConfig();
  const resolved: ResolvedModelConfig[] = entries.map((entry) => {
    validateModel(entry);
    const { apiKeyEnv, apiKey, ...model } = entry;
    const environmentKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
    const key = environmentKey?.trim() ? environmentKey : apiKey;
    if (!key?.trim()) invalidConfig();
    return { ...model, apiKey: key };
  });
  return [...configureModels(resolved).values()];
}

export async function loadStartupModels(env: Readonly<Record<string, string | undefined>>) {
  const path = env.XIAOWEI_LLM_CONFIG;
  if (path === undefined) return [];
  if (!isAbsolute(path)) invalidConfig();
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch {
    invalidConfig();
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    !("models" in document) ||
    !Array.isArray(document.models)
  )
    invalidConfig();
  return resolveModels(document.models, env);
}
