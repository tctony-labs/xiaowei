// Test fixture builder; the production schema and validation live in llm/config.ts.
export function configDocument(models) {
  return {
    version: 1,
    defaults: {},
    providers: models.map(({ provider, api, baseUrl, apiKey, apiKeyEnv, ...model }, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      provider,
      api,
      baseUrl,
      apiKey,
      apiKeyEnv,
      supportsWebSocket: false,
      transport: "http",
      models: [model],
    })),
  };
}
