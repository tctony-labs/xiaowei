import { Worker } from "node:worker_threads";
import { LlmConfiguration } from "xiaowei-contracts";
import { bindClient, GatewayFailure } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import { attachWorker } from "xiaowei-gateway/worker-host";
import { encodeModels } from "./shared/configuration-codec";
import { configureModels, type ResolvedModelConfig } from "./shared/models";

export async function attachLlm(
  host: GatewayHost,
  models: readonly ResolvedModelConfig[],
  workerUrl = new URL("./llm-worker.js", import.meta.url),
) {
  const snapshot = [...configureModels(models).values()];
  const worker = new Worker(workerUrl, { workerData: { models: snapshot } });
  let owner: Awaited<ReturnType<typeof attachWorker>>;
  try {
    owner = await attachWorker(host, "llm", worker);
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const client = bindClient(LlmConfiguration, host.client({ caller: "llm-configuration", trusted: true }));
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  return {
    updateModels(entries: readonly ResolvedModelConfig[]) {
      if (closing)
        return Promise.reject(new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "LLM service closed" }));
      let request: ReturnType<typeof encodeModels>;
      try {
        request = encodeModels(entries);
      } catch (error) {
        return Promise.reject(error);
      }
      const update = queue.then(async () => {
        if (closing) throw new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "LLM service closed" });
        await client.replaceModels(request);
      });
      queue = update.catch(() => {});
      return update;
    },
    close() {
      closing ??= (async () => {
        await owner.close();
        await queue;
      })();
      return closing;
    },
  };
}
