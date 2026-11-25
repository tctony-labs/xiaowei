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

test("automatic compaction restores the checkpoint and preserves older paginated tool details", {
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
  const { AgentChatClient } = await import("../../src/renderer/src/components/agent-chat/client");
  const { createServices } = await import("../../src/renderer/src/services");
  const root = await mkdtemp(join(tmpdir(), "xiaowei-compaction-"));
  const requests = [];
  const original = "Original answer retained in the session timeline.";
  const summary = "Keep the confirmed decision and pending work.";
  const longContents = "old tool content 😀 ".repeat(4_000);
  const write = { path: "original.txt", contents: longContents };
  const fillers = 19;
  const lastBeforeCompaction = 2 + fillers;
  const responses = new Map([
    [2, original],
    [lastBeforeCompaction + 1, summary],
    [lastBeforeCompaction + 2, "Answer after compaction."],
    [lastBeforeCompaction + 3, "Answer after reopen."],
  ]);
  const model = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const sequence = requests.length;
    const promptTokens = sequence === lastBeforeCompaction ? 51_300 : 500;
    const response = { id: `fixture-${sequence}`, model: "chat" };
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) =>
      outgoing.write(`data: ${JSON.stringify({ ...response, ...event })}\n\n`);
    if (sequence === 1) {
      const toolCall = {
        index: 0,
        id: "original-write",
        type: "function",
        function: { name: "Write", arguments: JSON.stringify(write) },
      };
      send({
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] } }],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const text = responses.get(sequence) ?? "Short filler response.";
      send({
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
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
  let closeHistory;
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
          return { compacting, runId: finished.runId };
        }
      }
    };

    observer = await observe();
    const originalRun = await run("original instruction");
    assert.equal(originalRun.compacting, false);
    for (let index = 0; index < fillers; index++) {
      assert.equal((await run(`filler ${index}`)).compacting, false);
    }
    assert.equal((await run("new instruction")).compacting, true);
    await observer.cancel();
    observer = undefined;
    await agent.close();
    await endpoint.close();
    agent = await Agent.open(join(root, "agent"));
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    observer = await observe();
    assert.equal((await run("after reopening")).compacting, false);

    assert.equal(requests.length, lastBeforeCompaction + 3);
    const [compact, after, reopened] = requests.slice(lastBeforeCompaction);
    const [first] = requests;
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
    const history = new AgentChatClient(
      createServices(() => host.client({ caller: "compaction-history", trusted: true })),
    );
    closeHistory = history.observe(() => {});
    await history.switchSession(sessionId);
    assert.equal(history.session.runs.length, 20);
    assert.ok(history.session.runs.every((run) => run.runId !== originalRun.runId));
    await history.loadOlderRuns();
    assert.equal(history.session.runs.length, 22);
    const [restoredOriginal] = history.session.runs;
    assert.equal(restoredOriginal.runId, originalRun.runId);
    const tool = restoredOriginal.items.find((item) => item.content.case === "toolCall");
    assert.ok(tool.shortenedFields.includes(pb.AgentItemField.TOOL_ARGUMENTS));
    const field = pb.AgentItemField.TOOL_ARGUMENTS;
    const full = await history.loadItemContent(originalRun.runId, tool.itemId, [field]);
    assert.deepEqual(JSON.parse(full.get(field)), write);
    const card = history.messages
      .find((message) => message.id === originalRun.runId)
      .blocks.find((block) => block.id === tool.itemId);
    assert.equal(card.kind, "tool");
    assert.deepEqual(JSON.parse(card.call.argumentsJson), write);

    const timeline = history.session.runs
      .flatMap((run) => run.items)
      .flatMap((item) => (item.content.case === "agentMessage" ? [item.content.value.text] : []))
      .join("\n");
    assert.ok(timeline.includes(original));
    assert.ok(!timeline.includes(summary));
  } finally {
    closeHistory?.();
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
