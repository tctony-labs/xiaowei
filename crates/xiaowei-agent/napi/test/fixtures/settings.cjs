// Desktop Settings for isolated Agent tests; never reads user configuration.
async function settingsFixture(host) {
  const { create, toBinary } = await import("@bufbuild/protobuf");
  const { EmptySchema } = await import("@bufbuild/protobuf/wkt");
  const pb = await import("proto-desktop-ts");
  const { bindHandlers, bindEvent } = await import("xiaowei-gateway");
  let current = create(pb.WebSearchRuntimeConfigSchema, { provider: pb.WebSearchProvider.BING });
  let reads = 0;
  let fail = false;
  let beforeRead;
  const owner = host.registerOwner(
    "test-settings",
    bindHandlers(
      pb.Settings,
      {
        async getWebSearchRuntimeConfig(request) {
          reads += 1;
          const config = create(pb.WebSearchRuntimeConfigSchema, current);
          if (beforeRead) await beforeRead();
          if (fail) throw new Error("fixture settings read failed");
          if (request.provider !== undefined && request.provider !== current.provider) {
            if (request.provider !== pb.WebSearchProvider.BING) throw new Error("key missing");
            return create(pb.WebSearchRuntimeConfigSchema, { provider: pb.WebSearchProvider.BING });
          }
          return config;
        },
      },
      { partial: true },
    ),
    [bindEvent(pb.SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  return {
    close: () => owner.close(),
    get reads() {
      return reads;
    },
    set beforeRead(value) {
      beforeRead = value;
    },
    set fail(value) {
      fail = value;
    },
    async update(provider, apiKey) {
      current = create(pb.WebSearchRuntimeConfigSchema, { provider, apiKey });
      owner.publish(
        pb.SettingsChangedSchema.typeName,
        toBinary(
          pb.SettingsChangedSchema,
          create(pb.SettingsChangedSchema, { snapshot: create(pb.SettingsSnapshotSchema) }),
        ),
      );
    },
  };
}

module.exports = { settingsFixture };
