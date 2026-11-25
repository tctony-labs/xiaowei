const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Worker } = require("node:worker_threads");
const { bundledWorkerUrl } = require("../../../scripts/tests/bundled-worker.cjs");

function id() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

test("automatic compaction uses an isolated Pi request and restores the checkpoint", {
  timeout: 30000,
}, async () => {
  const { Agent } = require("xiaowei-agent");
  const { Storage } = require("xiaowei-rust");
  const { create } = await import("@bufbuild/protobuf");
  const pb = await import("proto-desktop-ts");
  const { bindClient, bindStreamClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const { attachWorker } = await import("xiaowei-gateway/worker-host");
  const root = await mkdtemp(join(tmpdir(), "xiaowei-compaction-"));
  const requests = [];
  const original = "Original answer retained in the session timeline.";
  const summary = "Keep the confirmed decision and pending work.";
  const model = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const sequence = requests.length;
    const promptTokens = sequence === 1 ? 51_300 : sequence === 2 ? 51_500 : 500;
    const text = [original, summary, "Answer after compaction.", "Answer after reopen."][
      sequence - 1
    ];
    const response = { id: `fixture-${sequence}`, model: "chat" };
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) =>
      outgoing.write(`data: ${JSON.stringify({ ...response, ...event })}\n\n`);
    send({
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 10,
        total_tokens: promptTokens + 10,
        prompt_tokens_details: { cached_tokens: Math.min(promptTokens, 1_000) },
      },
    });
    outgoing.end("data: [DONE]\n\n");
  });
  const host = new GatewayHost();
  let agent;
  let endpoint;
  let llm;
  let settings;
  let observer;
  try {
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const models = [
      {
        id: "chat",
        modelId: "chat",
        name: "chat",
        api: "openai-completions",
        provider: "openai",
        providerName: "fixture",
        reasoning: false,
        input: ["text"],
        maxTokens: 10_000,
        contextWindow: 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKey: "fixture-model-key",
        // Pi enables the OpenAI cache key for this URL marker. The fixture stays on loopback.
        baseUrl: `http://127.0.0.1:${model.address().port}/api.openai.com`,
      },
    ];
    const worker = new Worker(bundledWorkerUrl, { workerData: { models } });
    llm = await attachWorker(host, "llm", worker);
    const database = await Storage.open(join(root, "settings.sqlite"));
    settings = await attachRustNapi(
      host,
      "settings",
      database.createSettingsGatewayEndpoint("darwin"),
    );
    agent = await Agent.open(join(root, "agent"));
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const client = host.client({ caller: "compaction-fixture", trusted: true });
    const api = bindClient(pb.Agent, client);
    const stream = bindStreamClient(pb.Agent, client);
    const { session } = await api.createSession(
      create(pb.CreateSessionRequestSchema, {
        clientRequestId: id(),
        config: { modelRef: "chat" },
      }),
    );
    const sessionId = session.sessionId;
    await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, {
        sessionId,
        title: "Compaction fixture",
      }),
    );
    const observe = () =>
      stream.subscribeSession(create(pb.SubscribeSessionRequestSchema, { sessionId }));
    const run = async (text) => {
      const { run: started } = await api.startRun(
        create(pb.StartRunRequestSchema, {
          sessionId,
          inputId: id(),
          input: [{ content: { case: "text", value: text } }],
        }),
      );
      let compacting = false;
      for (;;) {
        const { value, done } = await observer.next();
        assert.equal(done, false, "missing RunCompleted");
        if (value.payload.case === "generationUpdated") {
          compacting ||= value.payload.value.generation?.isCompaction === true;
        }
        if (value.payload.case === "runCompleted") {
          const finished = value.payload.value.run;
          assert.equal(finished.runId, started.runId);
          assert.equal(finished.status, pb.AgentRunStatus.COMPLETED, finished.error);
          return compacting;
        }
      }
    };

    observer = await observe();
    assert.equal(await run("original instruction"), false);
    assert.equal(await run("new instruction"), true);
    await observer.cancel();
    observer = undefined;
    await agent.close();
    await endpoint.close();
    agent = await Agent.open(join(root, "agent"));
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    observer = await observe();
    assert.equal(await run("after reopening"), false);

    assert.equal(requests.length, 4);
    const [first, compact, after, reopened] = requests;
    assert.equal(first.prompt_cache_key, sessionId);
    assert.equal(compact.prompt_cache_key, undefined);
    assert.equal(compact.max_completion_tokens, 4096);
    assert.equal(compact.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(compact.messages), /Distinguish observed and unknown outcomes\./);
    assert.match(JSON.stringify(compact.messages), /Original answer retained/);
    assert.doesNotMatch(JSON.stringify(compact.messages), /new instruction/);
    assert.equal(after.prompt_cache_key, sessionId);
    assert.deepEqual(after.tools, first.tools);
    assert.ok(after.tools.length > 0);
    for (const request of [after, reopened]) {
      const messages = JSON.stringify(request.messages);
      assert.match(messages, /original instruction/);
      assert.match(messages, /Keep the confirmed decision/);
      assert.doesNotMatch(messages, /Original answer retained/);
    }
    const raw = await api.readSession(
      create(pb.ReadSessionRequestSchema, {
        sessionId,
        includeRuns: true,
      }),
    );
    const timeline = raw.session.runs
      .flatMap((run) => run.items)
      .flatMap((item) => (item.content.case === "agentMessage" ? [item.content.value.text] : []))
      .join("\n");
    assert.ok(timeline.includes(original));
    assert.ok(!timeline.includes(summary));
  } finally {
    await observer?.cancel().catch(() => {});
    await agent?.close();
    await endpoint?.close();
    await llm?.close();
    await settings?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
