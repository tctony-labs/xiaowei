import { create } from "@bufbuild/protobuf";
import { EmptySchema, Llm, ModelInfoSchema, ModelInput } from "xiaowei-contracts";
import { bindHandlers, bindStreamHandlers, GatewayFailure } from "xiaowei-gateway";
import { decodeModels } from "../shared/configuration-codec";
import { configureModels, type ResolvedModelConfig } from "../shared/models";
import { listModels } from "./catalog";
import { generate } from "./provider";

export function llmRegistrations(configs: readonly ResolvedModelConfig[]) {
  let models = configureModels(configs);
  const streams = bindStreamHandlers(Llm, {
    generate: (request, client) => generate(request, models, client.cancellation()),
    modelCatalog: (request, client) => listModels(request, models, client.cancellation()),
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
    ...bindHandlers(Llm, {
      getModelInfo(request) {
        const model = models.get(request.modelRef);
        if (!model) throw new GatewayFailure({ code: "NOT_FOUND", message: "unknown model reference" });
        return create(ModelInfoSchema, {
          modelRef: model.id,
          providerName: model.providerName,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input.map((input) => (input === "text" ? ModelInput.TEXT : ModelInput.IMAGE)),
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        });
      },
      setModels(request) {
        const next = decodeModels(request.models);
        models = next;
        const providerCount = new Set([...models.values()].map((model) => model.provider)).size;
        console.info("LLM models updated: loaded %d models from %d providers", models.size, providerCount);
        return create(EmptySchema);
      },
    }),
  ];
}
