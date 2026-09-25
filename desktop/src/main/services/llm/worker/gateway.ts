import { create } from "@bufbuild/protobuf";
import { EmptySchema, Llm, LlmConfiguration, ModelCatalog } from "xiaowei-contracts";
import { bindHandlers, bindStreamHandlers } from "xiaowei-gateway";
import { decodeModels } from "../shared/configuration-codec";
import { configureModels, type ResolvedModelConfig } from "../shared/models";
import { listModels } from "./catalog";
import { generate } from "./provider";

export function llmRegistrations(configs: readonly ResolvedModelConfig[]) {
  let models = configureModels(configs);
  const streams = bindStreamHandlers(Llm, {
    generate: (request, _client, signal) => generate(request, models, signal),
  }).map((registration) => ({
    ...registration,
    streamPolicy: {
      maxChunkBytes: 1024 * 1024,
      producerIdleMs: 30_000,
      consumerIdleMs: 30_000,
      totalMs: 120_000,
    },
  }));
  return [
    ...streams,
    ...bindStreamHandlers(ModelCatalog, {
      listModels: (request, _client, signal) => listModels(request, models, signal),
    }),
    ...bindHandlers(LlmConfiguration, {
      replaceModels(request) {
        const next = decodeModels(request.models);
        models = next;
        return create(EmptySchema);
      },
    }),
  ];
}
