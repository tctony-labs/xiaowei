import { Llm } from "xiaowei-contracts";
import { bindStreamHandlers } from "xiaowei-gateway";
import { configureModels, generate, type ModelConfig } from "./provider";

export function llmRegistrations(configs: readonly ModelConfig[]) {
  const models = configureModels(configs);
  return bindStreamHandlers(Llm, {
    generate: (request, _client, signal) => generate(request, models, signal),
  }).map((registration) => ({
    ...registration,
    streamPolicy: {
      maxOwnerStreams: 4,
      maxCallerStreams: 2,
      maxChunkBytes: 1024 * 1024,
      producerIdleMs: 30_000,
      consumerIdleMs: 30_000,
      totalMs: 120_000,
    },
  }));
}
