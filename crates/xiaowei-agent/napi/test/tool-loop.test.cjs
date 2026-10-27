const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir, homedir } = require("node:os");
const { join } = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { bundledWorkerUrl } = require("../../../../scripts/tests/bundled-worker.cjs");
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
const scenarios = [
  {
    name: "todo updates",
    file: "todo-acceptance.txt",
    calls: [
      [
        "TodoWrite",
        {
          todos: [
            { id: "a", content: "写入文件", status: "in_progress" },
            { id: "b", content: "读取文件", status: "pending" },
            { id: "c", content: "取消的任务", status: "cancelled" },
          ],
        },
      ],
      [
        "TodoWrite",
        {
          merge: true,
          todos: [
            { id: "a", content: "写入文件", status: "completed" },
            { id: "b", content: "读取文件", status: "in_progress" },
          ],
        },
      ],
      ["Write", { path: "todo-acceptance.txt", contents: "hello\nxiaowei\n" }],
      ["Read", { path: "todo-acceptance.txt" }],
    ],
    prompt:
      "严格只按以下顺序调用四次工具：" +
      "先 TodoWrite 完整清单，a 写入文件为 in_progress，b 读取文件为 pending，" +
      "c 取消的任务为 cancelled。再 TodoWrite merge=true，" +
      "将 a 改为 completed、b 改为 in_progress，省略 c 以验证合并保留。" +
      "然后 Write todo-acceptance.txt 内容 hello\\nxiaowei\\n（真实换行），" +
      "最后 Read 此文件并总结。清单状态是验收样本，结束时保持第二次结果，无需再次更新。",
  },
  {
    name: "interactive decisions",
    interactive: true,
    file: "interactive-acceptance.txt",
    calls: [
      ["AskUserQuestion", { question: "选择内容", options: ["A", "B"], multi_select: true }],
      ["RequestPermission", { path: "fixture-target", is_directory: false, reason: "验收" }],
      ["Write", { path: "interactive-acceptance.txt", contents: "hello\nxiaowei\n" }],
      ["Read", { path: "interactive-acceptance.txt" }],
    ],
    prompt:
      "依次调用 AskUserQuestion（选项 A、B）、RequestPermission 申请文件 {target} 的写权限，" +
      "各自等真实回答后，用 Write 写入 hello\\nxiaowei\\n（真实换行），最后 Read 并确认。",
  },
  {
    name: "real files",
    file: "acceptance.txt",
    calls: [
      ["Write", { path: "acceptance.txt", contents: "hello\nworld\n" }],
      ["Read", { path: "acceptance.txt" }],
      ["Edit", { path: "acceptance.txt", old_string: "world", new_string: "xiaowei" }],
      ["Read", { path: "acceptance.txt" }],
    ],
    prompt:
      "严格依次调用 Write、Read、Edit、Read。\n" +
      "先在当前工作目录的 acceptance.txt 写入 hello\\nworld\\n（真实换行），读取，" +
      "然后把 world 替换成 xiaowei，再读取确认。最终用中文说明结果。只操作这个临时文件。",
  },
  {
    name: "file search",
    file: "fixtures/search-acceptance.txt",
    calls: [
      ["Write", { path: "fixtures/search-acceptance.txt", contents: "hello\nxiaowei\n" }],
      ["Glob", { pattern: "search-*.txt" }],
      ["Grep", { pattern: "^xiaowei$", include: "*.txt" }],
      ["Read", { path: "fixtures/search-acceptance.txt" }],
    ],
    prompt:
      "严格依次调用 Write、Glob、Grep、Read。先用 Write 在当前工作目录创建 " +
      "fixtures/search-acceptance.txt，内容为 hello\\nxiaowei\\n（真实换行）。" +
      "然后 Glob pattern 为 search-*.txt；Grep pattern 为 ^xiaowei$，include 为 *.txt；" +
      "最后 Read 找到的文件，说明匹配行号和最终内容。只操作这个临时文件。",
  },
];
if (process.platform === "darwin") {
  scenarios.push({
    name: "sandboxed Bash",
    file: "bash-acceptance.txt",
    calls: [
      [
        "Bash",
        {
          description: "Create the temporary acceptance file",
          command: "printf 'hello\\nxiaowei\\n' > bash-acceptance.txt; printf shell-output",
        },
      ],
      ["Read", { path: "bash-acceptance.txt" }],
    ],
    prompt:
      "严格依次调用 Bash、Read。Bash command 必须是：\n" +
      "printf 'hello\\nxiaowei\\n' > bash-acceptance.txt; printf shell-output\n" +
      "随后 Read bash-acceptance.txt 确认真实内容，最终用中文说明结果。只操作这个临时文件。",
  });
}

for (const scenario of scenarios) {
  const provider = live ? "live model" : "Pi provider";
  test(
    `formal Agent → Gateway → worker → ${provider} → ${scenario.name}`,
    {
      timeout: live ? 180000 : 30000,
    },
    () => exerciseScenario(scenario),
  );
}

async function exerciseScenario(scenario) {
  const pb = await import("proto-desktop-ts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient, bindStreamClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const { attachWorker } = await import("xiaowei-gateway/worker-host");
  const calls = scenario.calls.map(([name, args]) => [name, { ...args }]);
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
  await require("./fixtures/settings.cjs").settingsFixture(host);
  const worker = new Worker(bundledWorkerUrl, { workerData: { models } });
  const agent = await Agent.open(root);
  let llm;
  let endpoint;
  let observer;
  const deliveries = [];
  try {
    llm = await attachWorker(host, "llm", worker);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const client = host.client({ caller: "file-acceptance", trusted: true });
    const api = bindClient(pb.Agent, client);
    const stream = bindStreamClient(pb.Agent, client);
    const otherClient = host.client({ caller: "other-interaction-device", trusted: true });
    const otherApi = bindClient(pb.Agent, otherClient);
    const otherStream = bindStreamClient(pb.Agent, otherClient);
    const session = (
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: id(),
          config: { modelRef, reasoning },
        }),
      )
    ).session;
    assert.ok(session.cwd.endsWith(`/quick-chat/${session.sessionId}`));
    const permissionTarget = join(session.cwd, scenario.file);
    if (scenario.interactive) {
      calls.find(([name]) => name === "RequestPermission")[1].path = permissionTarget;
      for (const streamApi of [stream, otherStream]) {
        const source = await streamApi.observeInteractions(
          create(pb.ObserveInteractionsRequestSchema, {
            sessionId: session.sessionId,
          }),
        );
        const ready = (await source.next()).value;
        assert.equal(ready.payload.case, "ready");
        deliveries.push({ source, ready: ready.payload.value });
      }
    }
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
              value: `工具验收 ${nonce}：${scenario.prompt.replace("{target}", permissionTarget)}`,
            },
          },
        ],
      }),
    );
    let completed;
    for await (const event of observer) {
      if (
        event.payload.case === "interactionUpdated" &&
        event.payload.value.interaction.status === pb.AgentInteractionStatus.PENDING
      ) {
        const interaction = event.payload.value.interaction;
        assert.equal(scenario.interactive, true);
        const receipts = [];
        for (const { source, ready } of deliveries) {
          const frame = (await source.next()).value;
          assert.equal(frame.payload.case, "delivery");
          assert.equal(frame.payload.value.interaction.interactionId, interaction.interactionId);
          receipts.push(
            create(pb.AcknowledgeInteractionRequestSchema, {
              instanceId: ready.instanceId,
              observerId: ready.observerId,
              deliveryId: frame.payload.value.deliveryId,
              interactionId: interaction.interactionId,
            }),
          );
        }
        await assert.rejects(api.acknowledgeInteraction(receipts[1]));
        await api.acknowledgeInteraction(receipts[0]);
        const snapshot = (
          await api.readSession(
            create(pb.ReadSessionRequestSchema, {
              sessionId: session.sessionId,
              includeRuns: true,
            }),
          )
        ).session;
        assert.equal(snapshot.runs.length, 1);
        assert.equal(snapshot.runs[0].generation, undefined);
        if (interaction.request.case === "permission") {
          assert.equal(interaction.request.value.path, permissionTarget);
          assert.equal(interaction.request.value.isDirectory, false);
        }
        const command = create(pb.RespondInteractionRequestSchema, {
          sessionId: session.sessionId,
          interactionId: interaction.interactionId,
          clientRequestId: id(),
          expectedRevision: 1n,
          answer: {
            answer:
              interaction.request.case === "question"
                ? { case: "question", value: { selectedIndices: [1], text: "补充说明" } }
                : { case: "permission", value: { allow: true } },
          },
        });
        // This caller decides before its ACK. Retry succeeds, a competing caller cannot win.
        await otherApi.respondInteraction(command);
        await otherApi.respondInteraction(command);
        await assert.rejects(
          api.respondInteraction(
            create(pb.RespondInteractionRequestSchema, {
              ...command,
              clientRequestId: id(),
            }),
          ),
        );
        await otherApi.acknowledgeInteraction(receipts[1]);
      }
      if (event.payload.case === "runCompleted") {
        completed = event.payload.value.run;
        break;
      }
    }
    assert.equal(completed?.status, pb.AgentRunStatus.COMPLETED, completed?.error);
    assert.equal(await readFile(join(session.cwd, scenario.file), "utf8"), "hello\nxiaowei\n");
    const tools = completed.items
      .filter((item) => item.content.case === "toolCall")
      .map((item) => item.content.value);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      calls.map(([name]) => name),
    );
    assert.ok(tools.every((tool) => tool.status === pb.AgentToolStatus.COMPLETED));
    assert.ok(tools.at(-1).output.includes("xiaowei"));
    if (scenario.name === "sandboxed Bash") {
      assert.ok(tools[0].output.includes("shell-output"));
      const metadata = JSON.parse(tools[0].metadataJson);
      assert.equal(metadata.bash.exit_code, 0);
      assert.equal(metadata.bash.is_background, false);
      assert.equal(metadata.bash.cancelled, false);
    }
    if (scenario.name === "file search") {
      assert.ok(tools[1].output.includes("fixtures/search-acceptance.txt"));
      assert.ok(tools[2].output.includes("search-acceptance.txt:2:xiaowei"));
      assert.equal(JSON.parse(tools[1].metadataJson).search.truncated, false);
      assert.equal(JSON.parse(tools[2].metadataJson).search.truncated, false);
    }
    if (scenario.name === "todo updates") {
      const initial = JSON.parse(tools[0].metadataJson).todoWrite.todos;
      const merged = JSON.parse(tools[1].metadataJson).todoWrite.todos;
      assert.equal(initial.length, 3);
      assert.deepEqual(
        merged.map((todo) => todo.id),
        ["a", "b", "c"],
      );
      assert.deepEqual(
        merged.map((todo) => todo.status),
        ["completed", "in_progress", "cancelled"],
      );
    }
    assert.ok(
      completed.items.some(
        (item) => item.content.case === "agentMessage" && item.content.value.text,
      ),
    );
    if (!live) {
      assert.equal(requests.length, calls.length + 1);
      const expected = [
        "Edit",
        "Read",
        "Write",
        "Glob",
        "Grep",
        "AskUserQuestion",
        "RequestPermission",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
      ];
      if (process.platform === "darwin") expected.push("Bash");
      assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), expected.sort());
      assert.ok(JSON.stringify(requests[0].messages[0].content).includes("小微"));
      assert.ok(requests.at(-1).messages.at(-1).content.includes("xiaowei"));
      if (scenario.name === "sandboxed Bash") {
        assert.ok(requests[1].messages.at(-1).content.includes("shell-output"));
      }
      if (scenario.name === "file search") {
        assert.ok(requests[2].messages.at(-1).content.includes("search-acceptance.txt"));
        assert.ok(requests[3].messages.at(-1).content.includes("search-acceptance.txt:2:xiaowei"));
      }
    }
    console.log(
      JSON.stringify({
        acceptance: live ? "live" : "fixture",
        scenario: scenario.name,
        modelRef,
        toolCalls: tools.map((tool) => tool.name),
        finalStatus: "completed",
      }),
    );
  } finally {
    await observer?.cancel();
    for (const delivery of deliveries) await delivery.source.cancel();
    await agent.close();
    await endpoint?.close();
    await llm?.close();
    await worker.terminate();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
