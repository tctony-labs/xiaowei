import { create } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, KeyValue, KvEntrySchema, KvKeySchema } from "xiaowei-contracts";
import { bindClient, bindStreamClient } from "xiaowei-gateway";
import { createRendererClient, type GatewayBridge } from "xiaowei-gateway/renderer";

export function client(bridge: GatewayBridge) {
  const client = createRendererClient(bridge);
  return {
    async storage(write = true) {
      const meta = bindClient(KeyValue, client);
      const key = "test.acceptance";
      if (write) {
        await meta.set(create(KvEntrySchema, { key, json: '{"enabled":true}' }));
      }
      const stored = await meta.get(create(KvKeySchema, { key }));
      return { json: stored.json };
    },
    async echo() {
      const result = await bindClient(Fixture, client).echo(
        create(EnvelopeSchema, {
          id: 0xffffffffffffffffn,
          blobs: [{ data: Uint8Array.of(0, 255) }],
        }),
      );
      return { id: String(result.id), bytes: [...result.blobs[0].data] };
    },
    stream(text: string) {
      return bindStreamClient(Fixture, client).watch(create(EnvelopeSchema, { text, id: 100n }));
    },
    subscribe(callback: () => void) {
      return client.subscribe(ChangedSchema.typeName, undefined, callback);
    },
  };
}
