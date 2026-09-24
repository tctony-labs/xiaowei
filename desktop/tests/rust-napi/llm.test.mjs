import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema, Fixture, GenerateEventSchema, GenerateRequestSchema } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import { llmFixture, request, waitFor } from "../fixtures/llm.mjs";

const directory = fileURLToPath(new URL("../../../target/rust-napi-tests/search", import.meta.url));
const require = createRequire(import.meta.url);
const addon = require(`${directory}/${readdirSync(directory).find((path) => path.endsWith(".node"))}`);

// The only envelope wrapping is in this test harness. Rust decodes GenerateRequest,
// calls Llm.Generate with StreamMethod and encodes each typed GenerateEvent back.
test("Rust typed LLM caller reaches built worker/Pi and preserves terminal, error and cancellation", async (t) => {
  const fixture = await llmFixture(t);
  const native = await attachRustNapi(fixture.host, "rust-llm-test", addon.createGatewayFixture());
  t.after(() => native.close());
  const client = bindStreamClient(Fixture, fixture.host.client({ caller: "llm-native-test", trusted: true }));
  const open = (text) =>
    client.watch(
      create(EnvelopeSchema, {
        text: "llm",
        blobs: [{ data: toBinary(GenerateRequestSchema, request(text)) }],
      }),
    );
  const stream = await open("正常");
  const events = [];
  for await (const chunk of stream) {
    events.push(fromBinary(GenerateEventSchema, chunk.value.blobs[0].data).event);
  }
  assert.deepEqual(
    events.map((event) => event.case),
    ["textDelta", "textDelta", "usage", "finished"],
  );
  assert.equal(
    events
      .slice(0, 2)
      .map((event) => event.value.text)
      .join(""),
    "你好",
  );
  assert.equal(events[2].value.total, 10n);
  const broken = await open("truncated");
  const failures = [];
  for await (const chunk of broken) {
    failures.push(fromBinary(GenerateEventSchema, chunk.value.blobs[0].data).event);
  }
  assert.equal(failures.at(-1).case, "failed");
  assert.ok(!failures.some((event) => event.case === "finished"));
  const cancelled = await open("cancel");
  await cancelled.next();
  const pending = assert.rejects(cancelled.next(), (error) => error.detail?.code === "CANCELLED");
  await cancelled.cancel();
  await pending;
  await waitFor(() => fixture.disconnected.has("cancel"));
});
