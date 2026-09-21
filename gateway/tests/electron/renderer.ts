import { create } from "@bufbuild/protobuf";
import {
  ChangedSchema,
  Database,
  EnvelopeSchema,
  Fixture,
  Meta,
  MetaEntrySchema,
  MetaKeySchema,
  SqlStatementSchema,
} from "xiaowei-contracts";
import { bindClient, bindStreamClient } from "xiaowei-gateway";
import { createRendererClient, type GatewayBridge } from "xiaowei-gateway/renderer";

export function client(bridge: GatewayBridge) {
  const client = createRendererClient(bridge);
  return {
    async storage(write = true) {
      const database = bindClient(Database, client);
      const meta = bindClient(Meta, client);
      const key = "setting.acceptance";
      if (write) {
        await meta.set(create(MetaEntrySchema, { key, json: '{"enabled":true}' }));
      }
      const stored = await meta.get(create(MetaKeySchema, { key }));
      const result = await database.query(create(SqlStatementSchema, { sql: "SELECT 42 AS answer" }));
      return { json: stored.json, answer: String(result.rows[0].cells[0].kind.value) };
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
