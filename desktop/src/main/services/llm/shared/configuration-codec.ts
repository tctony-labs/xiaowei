import { create } from "@bufbuild/protobuf";
import { type ModelConfiguration, ModelInput, SetModelsRequestSchema } from "xiaowei-contracts";
import { configureModels, invalidConfig, type ResolvedModelConfig } from "./models";

export function encodeModels(entries: readonly ResolvedModelConfig[]) {
  const models = [...configureModels(entries).values()];
  return create(SetModelsRequestSchema, {
    models: models.map(({ cost, compat, thinkingLevelMap, samplingParams, input, ...model }) => ({
      ...model,
      input: input.map((value) => (value === "text" ? ModelInput.TEXT : ModelInput.IMAGE)),
      cost,
      costTiers: cost.tiers?.map(({ inputTokensAbove, ...rates }) => ({ inputTokensAbove, rates })),
      samplingParamsJson: samplingParams === undefined ? undefined : JSON.stringify(samplingParams),
      compatJson: compat === undefined ? undefined : JSON.stringify(compat),
      thinkingLevelMapJson: thinkingLevelMap === undefined ? undefined : JSON.stringify(thinkingLevelMap),
    })),
  });
}

export function decodeModels(entries: readonly ModelConfiguration[]) {
  try {
    return configureModels(
      entries.map((entry) => {
        if (!entry.cost || entry.costTiers.some((tier) => !tier.rates)) invalidConfig();
        const { $typeName: _type, ...cost } = entry.cost;
        return {
          id: entry.id,
          name: entry.name,
          provider: entry.provider,
          modelId: entry.modelId,
          api: entry.api as ResolvedModelConfig["api"],
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          headers: entry.headers,
          ...(entry.samplingParamsJson === undefined ? {} : { samplingParams: JSON.parse(entry.samplingParamsJson) }),
          reasoning: entry.reasoning,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          input: entry.input.map((value) => {
            if (value === ModelInput.TEXT) return "text";
            if (value === ModelInput.IMAGE) return "image";
            return invalidConfig();
          }),
          cost: {
            ...cost,
            tiers: entry.costTiers.map((tier) => {
              if (!tier.rates) invalidConfig();
              const { $typeName: _type, ...rates } = tier.rates;
              return { ...rates, inputTokensAbove: tier.inputTokensAbove };
            }),
          },
          ...(entry.compatJson === undefined ? {} : { compat: JSON.parse(entry.compatJson) }),
          ...(entry.thinkingLevelMapJson === undefined
            ? {}
            : { thinkingLevelMap: JSON.parse(entry.thinkingLevelMapJson) }),
        };
      }),
    );
  } catch {
    invalidConfig();
  }
}
