import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ListModelsRequestSchema, ModelCatalog } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { llmFixture, waitFor } from "../fixtures/llm.mjs";

for (const format of ["openai", "anthropic"]) {
  test(`${format}: catalog pages, absent metadata, failures and cancellation through built worker`, async (t) => {
    const calls = [];
    let closed = false;
    const server = createServer((request, response) => {
      calls.push(request);
      if (request.url === "/slow") {
        response.on("close", () => {
          closed = true;
        });
        return;
      }
      if (request.url === "/error") {
        response.writeHead(401);
        response.end("test-key secret");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/empty") response.end(JSON.stringify({ data: [] }));
      else if (request.url.includes("after_id"))
        response.end(JSON.stringify({ data: [{ id: "two" }], has_more: false }));
      else
        response.end(
          JSON.stringify({
            data: [
              {
                id: "one",
                name: "First",
                context_window: 8192,
                max_output_tokens: 1024,
                input_modalities: ["text", "image"],
              },
            ],
            has_more: true,
            last_id: "one",
          }),
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const fixture = await llmFixture(t);
    const catalog = bindStreamClient(ModelCatalog, fixture.host.client({ caller: "catalog-test", trusted: true }));
    const open = (path) =>
      catalog.listModels(
        create(ListModelsRequestSchema, {
          modelRef: "test",
          format,
          url: `http://127.0.0.1:${server.address().port}${path}`,
        }),
      );
    const pages = [];
    for await (const page of await open("/models")) pages.push(page);
    assert.deepEqual(
      pages.flatMap((page) => page.models.map((model) => model.modelId)),
      ["one", "two"],
    );
    assert.equal(pages[1].models[0].contextWindow, undefined);
    assert.equal(
      calls[0].headers[format === "openai" ? "authorization" : "x-api-key"],
      format === "openai" ? "Bearer test-key" : "test-key",
    );
    const empty = await open("/empty");
    assert.deepEqual((await empty.next()).value.models, []);
    await empty.cancel();
    await assert.rejects(async () => {
      for await (const _ of await open("/error")) {
      }
    }, /catalog request failed/);
    const slow = await open("/slow");
    const pending = slow.next();
    const rejected = assert.rejects(pending);
    await waitFor(() => calls.some((request) => request.url === "/slow"));
    await slow.cancel();
    await rejected;
    await waitFor(() => closed);
  });
}
