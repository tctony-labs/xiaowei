import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindStreamClient } from "../../src/binding/index.js";
import { GatewayFailure } from "../../src/core/protocol.js";
import { GatewayHost } from "../../src/core/registry.js";
import { attachRustNapi, type RustNapiEndpoint } from "../../src/main/rust-napi.js";
import { workerFixture } from "../fixtures/worker-client.js";

const directory = fileURLToPath(new URL("../../../../target/rust-napi-tests/search", import.meta.url));
const require = createRequire(import.meta.url);
const addon = require(`${directory}/${readdirSync(directory).find((path) => path.endsWith(".node"))}`) as {
  createGatewayFixture(): RustNapiEndpoint;
};
const code = (code: string) => (error: unknown) => error instanceof GatewayFailure && error.detail.code === code;

test("real Rust typed caller → napi → main → worker pulls PB chunks and propagates cancellation and exit", async () => {
  const host = new GatewayHost();
  const native = await attachRustNapi(host, "rust", addon.createGatewayFixture());
  const fixture = await workerFixture({ peer: true }, host);
  const client = bindStreamClient(Fixture, host.client({ caller: "test", trusted: true }));
  try {
    const stream = await client.watch(create(EnvelopeSchema, { text: "relay-chunks", id: 3n }));
    const ids: bigint[] = [];
    for await (const chunk of stream) {
      assert.ok(chunk.value);
      ids.push(chunk.value.id);
    }
    assert.deepEqual(ids, [0n, 1n, 2n]);
    const failed = await client.watch(create(EnvelopeSchema, { text: "relay-fail", id: 3n }));
    await failed.next();
    await assert.rejects(failed.next(), code("INVALID_ARGUMENT"));
    const waiting = await client.watch(create(EnvelopeSchema, { text: "relay-wait", id: 3n }));
    const pending = assert.rejects(waiting.next(), code("CANCELLED"));
    await fixture.wait("waiting");
    await waiting.cancel();
    await pending;
    await fixture.wait("wait:returned");
    const exiting = await client.watch(create(EnvelopeSchema, { text: "relay-wait", id: 3n }));
    const failure = assert.rejects(exiting.next(), code("OWNER_UNAVAILABLE"));
    await fixture.wait("waiting");
    await fixture.worker.terminate();
    await failure;
  } finally {
    await fixture.close();
    await native.close();
  }
});
