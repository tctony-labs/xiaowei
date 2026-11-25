const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
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

test("typed Continue after Stop and reopen requires fresh approval for a repeated shell effect", {
  timeout: 45000,
  skip: process.platform !== "darwin",
}, async () => {
  const { Agent } = require("xiaowei-agent");
  const { Storage } = require("xiaowei-rust");
  const { create } = await import("@bufbuild/protobuf");
  const pb = await import("proto-desktop-ts");
  const { bindClient, bindStreamClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const { attachWorker } = await import("xiaowei-gateway/worker-host");
  const root = await mkdtemp(join(tmpdir(), "xiaowei-continue-"));
  const requests = [];
  const append = { command: "printf x >> effect.txt", description: "append one byte" };
  let resolveWaiting;
  const waiting = new Promise((resolve) => {
    resolveWaiting = resolve;
  });
  const model = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const sequence = requests.length;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finishReason = null) =>
      outgoing.write(
        `data: ${JSON.stringify({
          id: `fixture-${sequence}`,
          model: "chat",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    if (sequence === 2) {
      send({ role: "assistant", content: "waiting" });
      resolveWaiting();
      return;
    }
    if (sequence === 1 || sequence === 3) {
      const calls =
        sequence === 1
          ? [
              ["Bash", append],
              [
                "BgRun",
                {
                  description: "background fixture",
                  command: "printf '%s' $$ > shell.pid; exec sleep 60",
                },
              ],
            ]
          : [["Bash", { description: "different display label", command: append.command }]];
      send({
        role: "assistant",
        tool_calls: calls.map(([name, argumentsValue], index) => ({
          index,
          id: `call-${sequence}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        })),
      });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "continued" }, "stop");
    }
    outgoing.end("data: [DONE]\n\n");
  });
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
      maxTokens: 4096,
      contextWindow: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      apiKey: "fixture-model-key",
      baseUrl: `http://127.0.0.1:${model.address().port}`,
    },
  ];
  const host = new GatewayHost();
  const database = await Storage.open(join(root, "settings.sqlite"));
  const settings = await attachRustNapi(
    host,
    "settings",
    database.createSettingsGatewayEndpoint("darwin"),
  );
  const worker = await attachWorker(
    host,
    "llm",
    new Worker(bundledWorkerUrl, { workerData: { models } }),
  );
  const client = host.client({ caller: "continue-fixture", trusted: true });
  const api = bindClient(pb.Agent, client);
  const stream = bindStreamClient(pb.Agent, client);
  let agent = await Agent.open(join(root, "agent"));
  let endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
  let observer;
  try {
    const { session } = await api.createSession(
      create(pb.CreateSessionRequestSchema, {
        clientRequestId: id(),
        config: { modelRef: "chat" },
      }),
    );
    const sessionId = session.sessionId;
    const observe = () =>
      stream.subscribeSession(
        create(pb.SubscribeSessionRequestSchema, {
          sessionId,
        }),
      );
    const next = async (kind) => {
      for (;;) {
        const { value, done } = await observer.next();
        assert.equal(done, false, `missing ${kind}`);
        if (value.payload.case === kind) return value.payload.value;
      }
    };
    observer = await observe();
    const { run } = await api.startRun(
      create(pb.StartRunRequestSchema, {
        sessionId,
        inputId: id(),
        input: [{ content: { case: "text", value: "run the fixture" } }],
      }),
    );
    await waiting;
    const pid = Number(await readFile(join(session.cwd, "shell.pid"), "utf8"));
    process.kill(pid, 0);
    await api.interruptRun(
      create(pb.InterruptRunRequestSchema, {
        sessionId,
        runId: run.runId,
      }),
    );
    assert.equal((await next("runCompleted")).run.status, pb.AgentRunStatus.INTERRUPTED);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await observer.cancel();
    observer = undefined;
    await agent.close();
    await endpoint.close();
    agent = await Agent.open(join(root, "agent"));
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    observer = await observe();

    assert.equal(requests.length, 2);
    const request = create(pb.ContinueRunRequestSchema, {
      sessionId,
      previousRunId: run.runId,
      clientRequestId: id(),
    });
    const resumed = (await api.continueRun(request)).run;
    const repeated = (await api.continueRun(request)).run;
    assert.equal(repeated.runId, resumed.runId);
    assert.equal(resumed.continuedFromRunId, run.runId);
    assert.equal(resumed.inputId, "");
    const { interaction } = await next("interactionUpdated");
    assert.equal(interaction.request.case, "toolExecution");
    assert.equal(await readFile(join(session.cwd, "effect.txt"), "utf8"), "x");
    await api.respondInteraction(
      create(pb.RespondInteractionRequestSchema, {
        sessionId,
        expectedRevision: 1n,
        interactionId: interaction.interactionId,
        clientRequestId: id(),
        answer: { answer: { case: "toolExecution", value: { allow: false } } },
      }),
    );
    const finished = (await next("runCompleted")).run;
    assert.equal(finished.status, pb.AgentRunStatus.COMPLETED);
    assert.ok(finished.items.every((item) => item.content.case !== "userMessage"));
    assert.equal(await readFile(join(session.cwd, "effect.txt"), "utf8"), "x");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(requests.length, 4);
    assert.equal(requests[2].messages.filter((entry) => entry.role === "user").length, 1);
    assert.ok(requests[2].messages.some((entry) => entry.role === "tool"));
    await observer.cancel();
    observer = undefined;
    await agent.close();
    await endpoint.close();
    agent = await Agent.open(join(root, "agent"));
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const afterReopen = (await api.continueRun(request)).run;
    assert.equal(afterReopen.runId, resumed.runId);
    assert.equal(afterReopen.status, pb.AgentRunStatus.COMPLETED);
    assert.equal(requests.length, 4);
  } finally {
    await observer?.cancel().catch(() => {});
    await agent.close();
    await endpoint.close();
    await worker.close();
    await settings.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
