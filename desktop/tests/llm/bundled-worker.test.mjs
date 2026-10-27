import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema, Llm } from "proto-desktop-ts";
import { bindStreamClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { textEvents, until, websocketFixture } from "../../../patches/tests/fixtures/websocket.mjs";
import artifacts from "../../../scripts/tests/bundled-worker.cjs";
import { attachLlm } from "../../src/main/services/llm/host.ts";
import { llmFixture, request, waitFor } from "../fixtures/llm.mjs";

let directory;
let workerUrl;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "xiaowei-bundled-worker-"));
  await cp(artifacts.bundledMainDir, join(directory, "main"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  workerUrl = pathToFileURL(join(directory, "main/llm-worker.js"));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("isolated provider chunks load with plain Node and no dependency directories", async () => {
  assert.deepEqual((await readdir(directory)).sort(), ["main", "package.json"]);
  const chunks = await readdir(join(directory, "main/chunks"));
  const providers = [];
  for (const api of [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-vertex",
    "mistral-conversations",
    "pi-messages",
  ]) {
    const chunk = chunks.find((name) => name.startsWith(`${api}-`));
    assert.ok(chunk, `missing provider chunk: ${api}`);
    providers.push(chunk);
  }
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { Worker } from "node:worker_threads";
        import { pathToFileURL } from "node:url";

        const directory = new URL("./main/chunks/", pathToFileURL(process.cwd() + "/"));
        const files = JSON.parse(process.argv[1]).map((file) => new URL(file, directory).href);
        const worker = new Worker(\`
          const { parentPort } = await import("node:worker_threads");
          for (const file of \${JSON.stringify(files)}) {
            await import(file);
          }
          parentPort.postMessage({ providersLoaded: \${files.length} });
        \`, { eval: true, execArgv: [], workerData: { models: [] } });
        worker.on("error", (error) => { throw error; });
        worker.on("message", async (message) => {
          if (message.providersLoaded !== files.length) return;
          await worker.terminate();
          console.log("providers=" + message.providersLoaded);
        });
      `,
      JSON.stringify(providers),
    ],
    { cwd: directory, env: { PATH: process.env.PATH }, timeout: 15000 },
  );
  assert.ok(stdout.trim().endsWith(`providers=${providers.length}`), stdout);
});

test("missing lazy provider chunk logs its safe cause before any HTTP request", async (t) => {
  const broken = await mkdtemp(join(tmpdir(), "xiaowei-missing-provider-"));
  t.after(() => rm(broken, { recursive: true, force: true }));
  await cp(directory, broken, { recursive: true });

  const logs = [];
  t.mock.method(console, "warn", (line) => logs.push(line));
  const fixture = await llmFixture(
    t,
    undefined,
    "openai-completions",
    pathToFileURL(join(broken, "main/llm-worker.js")),
  );
  const chunks = await readdir(join(broken, "main/chunks"));
  const provider = chunks.find((name) => name.startsWith("openai-completions-"));
  assert.ok(provider);
  // The worker is already ready; the provider implementation is loaded on demand.
  await rm(join(broken, "main/chunks", provider));

  const events = [];
  for await (const event of await fixture.client.generate(
    request("private-prompt", { options: { sessionId: "missing-provider-session" } }),
  ))
    events.push(event.event);

  assert.equal(events.at(-1).case, "failed");
  assert.equal(events.at(-1).value.message, "model generation failed");
  assert.equal(fixture.requests.length, 0);
  await waitFor(() => logs.some((line) => line.includes("provider_module_missing")));
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes(provider));
  assert.ok(logs[0].includes("missing-provider-session"));
  assert.ok(logs[0].includes("provider.ts:"));
  for (const secret of ["private-prompt", "test-key", broken])
    assert.ok(!logs[0].includes(secret), secret);
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
  test(`${api}: isolated worker streams, reports failures, cancels and shuts down`, async (t) => {
    const fixture = await llmFixture(t, undefined, api, workerUrl);
    const collect = async (text) => {
      const events = [];
      for await (const chunk of await fixture.client.generate(request(text)))
        events.push(chunk.event);
      return events;
    };
    const events = await collect("正常");
    assert.equal(events.at(-1).case, "finished");
    assert.equal(
      events
        .filter((event) => event.case === "textDelta")
        .map((event) => event.value.text)
        .join(""),
      "你好",
    );
    assert.ok(events.some((event) => event.case === "usage"));
    assert.equal(fixture.requests[0].auth, "Bearer test-key");
    for (const text of ["http-error", "truncated"]) {
      const failed = await collect(text);
      assert.equal(failed.at(-1).case, "failed");
      assert.ok(!failed.at(-1).value.message.includes("test-key"));
    }
    const stream = await fixture.client.generate(request("cancel"));
    await stream.next();
    await stream.cancel();
    await waitFor(() => fixture.disconnected.has("cancel"));
    const closing = await fixture.client.generate(request("close"));
    await closing.next();
    await fixture.owner.close();
    await waitFor(() => fixture.disconnected.has("close"));
  });
}

test("isolated worker loads WebSocket dependencies, reuses connections and cancels", async (t) => {
  const fixture = await websocketFixture(t, {
    message: ({ send, body }) => {
      const events = textEvents();
      const prompt = body.input.at(-1).content?.[0]?.text;
      (prompt === "pause" ? events.slice(0, 4) : events).forEach(send);
    },
  });
  const host = new GatewayHost();
  const owner = await attachLlm(
    host,
    [
      {
        id: "test",
        modelId: "text-model",
        name: "Test",
        provider: "openai",
        providerName: "Test",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: fixture.baseUrl,
        defaultTransport: "auto",
        reasoning: false,
        input: ["text"],
        contextWindow: 16384,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    workerUrl,
  );
  t.after(() => owner.close());
  const client = bindStreamClient(Llm, host.client({ caller: "bundled-test", trusted: true }));
  const input = (text) =>
    create(GenerateRequestSchema, {
      modelRef: "test",
      userText: text,
      options: { sessionId: "bundled-session" },
    });
  for (const text of ["one", "two"]) {
    const events = [];
    for await (const event of await client.generate(input(text))) events.push(event.event);
    assert.equal(events.at(-1).case, "finished");
  }
  assert.equal(fixture.connections, 1);
  const paused = await client.generate(input("pause"));
  while ((await paused.next()).value.event.case !== "textDelta") {}
  await paused.cancel();
  await until(() => fixture.closed === 1);
});

for (const api of ["google-generative-ai", "bedrock-converse-stream"]) {
  test(`${api}: isolated worker constructs a real SDK request to the local fixture`, async (t) => {
    const requests = [];
    const server = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      requests.push({
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        body: JSON.parse(Buffer.concat(chunks)),
      });
      if (api === "bedrock-converse-stream") {
        outgoing.writeHead(403, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ message: "fixture access denied" }));
      } else {
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.end(
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: "model", parts: [{ text: "你好" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          })}\n\n`,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const host = new GatewayHost();
    // Bedrock normally uses TLS bearer auth and HTTP/2. The local HTTP/1 fixture
    // uses the SDK's dummy-credential mode; these flags are copied into the worker.
    const flags = { AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1" };
    const previous = Object.fromEntries(Object.keys(flags).map((key) => [key, process.env[key]]));
    let owner;
    try {
      if (api === "bedrock-converse-stream") Object.assign(process.env, flags);
      owner = await attachLlm(
        host,
        [
          {
            id: "test",
            modelId: "text-model",
            name: "Test",
            provider: "test",
            providerName: "Test",
            api,
            apiKey: "fixture-key",
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            reasoning: false,
            input: ["text"],
            contextWindow: 16384,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        workerUrl,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    t.after(() => owner.close());
    const client = bindStreamClient(Llm, host.client({ caller: "bundled-test", trusted: true }));
    const events = [];
    for await (const chunk of await client.generate(request("正常"))) events.push(chunk.event);
    assert.equal(requests.length, 1, events.at(-1)?.value.message);
    const sent = requests[0];
    assert.equal(sent.method, "POST");
    if (api === "bedrock-converse-stream") {
      assert.equal(sent.path, "/model/text-model/converse-stream");
      assert.match(sent.headers.authorization, /^AWS4-HMAC-SHA256 Credential=dummy-access-key\//);
      assert.equal(sent.body.messages[0].content[0].text, "正常");
      assert.equal(events.at(-1).case, "failed");
    } else {
      assert.ok(sent.path.includes("models/text-model:streamGenerateContent"));
      assert.equal(sent.headers["x-goog-api-key"], "fixture-key");
      assert.equal(sent.body.contents[0].parts[0].text, "正常");
      assert.equal(events.at(-1).case, "finished");
      assert.equal(events.find((event) => event.case === "textDelta").value.text, "你好");
    }
  });
}
