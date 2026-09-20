import { create } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, bindStreamClient, bindStreamHandlers } from "../src/binding/index.js";
import type { Client } from "../src/core/client.js";

// Checked by tsgo, never executed. Every directive must correspond to a real error.
export function compileExamples(client: Client) {
  const streams = bindStreamClient(Fixture, client);
  // @ts-expect-error Unary method is absent from the stream client.
  streams.echo(create(EnvelopeSchema));
  bindStreamHandlers(Fixture, {
    // @ts-expect-error Stream handler yields Changed, not Envelope.
    watch: async function* () {
      yield create(EnvelopeSchema);
    },
  });
  const service = bindClient(Fixture, client);
  service.echo(create(EnvelopeSchema, { id: 1n }));
  // @ts-expect-error uint64 is bigint, not number.
  service.echo(create(EnvelopeSchema, { id: 1 }));
  // @ts-expect-error Request type is derived from the service descriptor.
  service.echo(create(ChangedSchema));
  // @ts-expect-error Streaming methods cannot be invoked as unary.
  service.watch(create(EnvelopeSchema));
  // @ts-expect-error Handler output must match the declared response.
  bindHandlers(Fixture, { echo: () => create(ChangedSchema) });
  // @ts-expect-error Missing unary handler.
  bindHandlers(Fixture, {});
}
