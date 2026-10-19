const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir, homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { Agent } = require("xiaowei-agent");

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

const live = process.env.XIAOWEI_AGENT_LIVE === "1";
test(`formal Agent → Gateway → worker → ${live ? "live model" : "Pi provider"} → real files`, {
  timeout: live ? 180000 : 30000,
}, async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient, bindStreamClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const { attachWorker } = await import("xiaowei-gateway/worker-host");
  const calls = [
    ["Write", { path: "acceptance.txt", contents: "hello\nworld\n" }],
    ["Read", { path: "acceptance.txt" }],
    ["Edit", { path: "acceptance.txt", old_string: "world", new_string: "xiaowei" }],
    ["Read", { path: "acceptance.txt" }],
  ];
  const requests = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const call = calls[requests.length - 1];
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      outgoing.write(
        `data: ${JSON.stringify({
          id: `response-${requests.length}`,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (call) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name: call[0], arguments: "" },
          },
        ],
      });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call[1]) } }] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "hello\nxiaowei\n" });
      send({}, "stop");
    }
    outgoing.end("data: [DONE]\n\n");
  });
  let models;
  let modelRef = "fixture";
  let reasoning;
  if (live) {
    const { loadConfig, resolveModels } = await import(
      "../../../../desktop/src/main/services/llm/config.ts"
    );
    const { document } = await loadConfig(
      process.env,
      join(process.env.XIAOWEI_AGENT_HOME ?? join(homedir(), ".xiaowei"), "models.json"),
    );
    models = resolveModels(document, process.env);
    modelRef = document.defaults.modelRef;
    reasoning = document.defaults.thinkingLevel;
    assert.ok(
      models.some((model) => model.id === modelRef),
      "default model is unavailable",
    );
  } else {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    models = [
      {
        id: modelRef,
        modelId: "fixture",
        name: "fixture",
        api: "openai-completions",
        provider: "openai",
        providerName: "fixture",
        reasoning: false,
        input: ["text"],
        maxTokens: 4096,
        contextWindow: 16000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      },
    ];
  }
  const root = await mkdtemp(join(tmpdir(), "xiaowei-file-acceptance-"));
  const host = new GatewayHost();
  const worker = new Worker(
    pathToFileURL(resolve(__dirname, "../../../../desktop/out/main/llm-worker.js")),
    { workerData: { models } },
  );
  const agent = await Agent.open(root);
  let llm;
  let endpoint;
  let observer;
  try {
    llm = await attachWorker(host, "llm", worker);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const client = host.client({ caller: "file-acceptance", trusted: true });
    const api = bindClient(pb.Agent, client);
    const stream = bindStreamClient(pb.Agent, client);
    const session = (
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: id(),
          config: { modelRef, reasoning },
        }),
      )
    ).session;
    assert.ok(session.cwd.endsWith(`/quick-chat/${session.sessionId}`));
    observer = await stream.subscribeSession(
      create(pb.SubscribeSessionRequestSchema, {
        sessionId: session.sessionId,
      }),
    );
    await observer.next();
    const nonce = randomUUID();
    await api.startRun(
      create(pb.StartRunRequestSchema, {
        sessionId: session.sessionId,
        inputId: id(),
        input: [
          {
            content: {
              case: "text",
              value:
                `工具验收 ${nonce}：严格依次调用 Write、Read、Edit、Read。\n` +
                "先在当前工作目录的 acceptance.txt 写入 hello\\nworld\\n（真实换行），读取，" +
                "然后把 world 替换成 xiaowei，再读取确认。最终用中文说明结果。只操作这个临时文件。",
            },
          },
        ],
      }),
    );
    let completed;
    for await (const event of observer) {
      if (event.payload.case === "runCompleted") {
        completed = event.payload.value.run;
        break;
      }
    }
    assert.equal(completed?.status, pb.AgentRunStatus.COMPLETED, completed?.error);
    assert.equal(await readFile(join(session.cwd, "acceptance.txt"), "utf8"), "hello\nxiaowei\n");
    const tools = completed.items
      .filter((item) => item.content.case === "toolCall")
      .map((item) => item.content.value);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["Write", "Read", "Edit", "Read"],
    );
    assert.ok(tools.every((tool) => tool.status === pb.AgentToolStatus.COMPLETED));
    assert.ok(tools[3].output.includes("xiaowei"));
    assert.ok(
      completed.items.some(
        (item) => item.content.case === "agentMessage" && item.content.value.text,
      ),
    );
    if (!live) {
      assert.equal(requests.length, 5);
      assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), [
        "Edit",
        "Read",
        "Write",
      ]);
      assert.ok(JSON.stringify(requests[0].messages[0].content).includes("小微"));
      assert.ok(requests[4].messages.at(-1).content.includes("xiaowei"));
    }
    console.log(
      JSON.stringify({
        acceptance: live ? "live" : "fixture",
        modelRef,
        toolCalls: tools.map((tool) => tool.name),
        finalStatus: "completed",
      }),
    );
  } finally {
    await observer?.cancel();
    await agent.close();
    await endpoint?.close();
    await llm?.close();
    await worker.terminate();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
