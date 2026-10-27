const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, readdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
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

async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (!process.env.XIAOWEI_WEB_FIXTURE_CHILD) {
  test("web tools through production addons, Settings, Gateway and LLM worker", {
    timeout: 60000,
  }, async () => {
    const fixture = await require("../fixtures/web.cjs").webFixture();
    try {
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawn(
        process.execPath,
        ["--conditions=source", "--import", "tsx", "--test", __filename],
        {
          env: {
            ...environment,
            XIAOWEI_WEB_FIXTURE_CHILD: fixture.url,
            HTTPS_PROXY: fixture.url,
            HTTP_PROXY: fixture.url,
            ALL_PROXY: fixture.url,
            NO_PROXY: "127.0.0.1,localhost",
            SSL_CERT_FILE: fixture.ca,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const chunks = [];
      child.stdout.on("data", (value) => chunks.push(value));
      child.stderr.on("data", (value) => chunks.push(value));
      const [code] = await once(child, "exit");
      const output = Buffer.concat(chunks).toString();
      assert.equal(code, 0, output);
      assert.match(output, /search, fetch, extraction, provider replacement, Stop and recovery/);
    } finally {
      await fixture.close();
    }
  });
} else {
  test("search, fetch, extraction, provider replacement, Stop and recovery", {
    timeout: 45000,
  }, async () => {
    const { Agent } = require("xiaowei-agent");
    const { Storage } = require("xiaowei-rust");
    const { create } = await import("@bufbuild/protobuf");
    const { EmptySchema } = await import("@bufbuild/protobuf/wkt");
    const pb = await import("proto-desktop-ts");
    const { bindClient, bindStreamClient, bindHandlers } = await import("xiaowei-gateway");
    const { GatewayHost } = await import("xiaowei-gateway/host");
    const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
    const { attachWorker } = await import("xiaowei-gateway/worker-host");
    const root = await mkdtemp(join(tmpdir(), "xiaowei-web-acceptance-"));
    const requests = [];
    let hangExtraction = false;
    const model = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      if (body.model === "small" && hangExtraction) return;
      const lastUser = body.messages.findLastIndex((message) => message.role === "user");
      const content = body.messages[lastUser]?.content;
      const input =
        typeof content === "string"
          ? content
          : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      const results = body.messages
        .slice(lastUser + 1)
        .filter((message) => message.role === "tool");
      let call;
      if (body.model !== "small") {
        if (results.length === 0) {
          call =
            input.startsWith("fetch") || input === "extract-stop"
              ? [
                  "WebFetch",
                  {
                    url: `https://example.com/${input === "fetch-stop" ? "hold-page" : "page"}`,
                    prompt: "What is the answer?",
                  },
                ]
              : ["WebSearch", { query: input === "hold" ? "hold" : "fixture", max_results: 2 }];
        } else if (input === "pipeline" && results.length === 1) {
          call = ["WebFetch", { url: "https://example.com/page", prompt: "Find the answer" }];
        }
      }
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        outgoing.write(
          `data: ${JSON.stringify({
            id: `response-${requests.length}`,
            model: body.model,
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
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({
          role: "assistant",
          content: body.model === "small" ? "The answer is 42." : "Answer: 42.",
        });
        send({}, "stop");
      }
      outgoing.end("data: [DONE]\n\n");
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const models = ["chat", "small"].map((modelId) => ({
      id: modelId,
      modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openai",
      providerName: "fixture",
      reasoning: false,
      input: ["text"],
      maxTokens: 4096,
      contextWindow: 16000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      apiKey: "fixture-model-key",
      baseUrl: `http://127.0.0.1:${model.address().port}`,
    }));
    const host = new GatewayHost();
    const database = await Storage.open(join(root, "settings.sqlite"));
    let runtimeReads = 0;
    let failRuntimeReads = false;
    let initialResponseReady = false;
    let releaseInitialRead;
    const initialReadGate = new Promise((resolve) => {
      releaseInitialRead = resolve;
    });
    const nativeSettings = database.createSettingsGatewayEndpoint("darwin");
    const instrumentedSettings = new Proxy(nativeSettings, {
      get(target, key) {
        if (key === "rpcControl")
          return (control, payload, context) => {
            const frame = JSON.parse(control);
            if (
              frame.operation === "invoke" &&
              frame.route?.name === "xiaowei.desktop.Settings.GetWebSearchRuntimeConfig"
            ) {
              runtimeReads += 1;
              if (runtimeReads === 1) {
                return Promise.resolve(target.rpcControl(control, payload, context)).then(
                  async (response) => {
                    initialResponseReady = true;
                    await initialReadGate;
                    return response;
                  },
                );
              }
              if (failRuntimeReads)
                return Promise.resolve(
                  JSON.stringify({
                    code: "HANDLER_ERROR",
                    message: "fixture runtime settings read failed",
                  }),
                );
            }
            return target.rpcControl(control, payload, context);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const settingsEndpoint = await attachRustNapi(host, "settings", instrumentedSettings);
    const auxiliary = host.registerOwner(
      "auxiliary",
      bindHandlers(
        pb.ModelSettings,
        {
          getAuxiliaryModelRef: () => create(pb.AuxiliaryModelRefSchema, { modelRef: "small" }),
        },
        { partial: true },
      ),
    );
    const worker = new Worker(bundledWorkerUrl, {
      workerData: { models },
    });
    const llm = await attachWorker(host, "llm", worker);
    const client = host.client({ caller: "web-acceptance", trusted: true });
    const api = bindClient(pb.Agent, client);
    const stream = bindStreamClient(pb.Agent, client);
    const settings = bindClient(pb.Settings, client);
    let agent = await Agent.open(join(root, "agent"));
    const activating = attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    await until(() => initialResponseReady);
    // Commit changes while the initial old Bing response is still in flight.
    await settings.update(
      create(pb.UpdateSettingsRequestSchema, {
        change: {
          case: "webSearchApiKey",
          value: {
            provider: pb.WebSearchProvider.TAVILY,
            apiKey: "tavily-fixture-a",
          },
        },
      }),
    );
    await settings.update(
      create(pb.UpdateSettingsRequestSchema, {
        change: { case: "webSearchProvider", value: pb.WebSearchProvider.TAVILY },
      }),
    );
    releaseInitialRead();
    let endpoint = await activating;
    const state = async () =>
      (await fetch(`${process.env.XIAOWEI_WEB_FIXTURE_CHILD}/state`)).json();
    const release = () => fetch(`${process.env.XIAOWEI_WEB_FIXTURE_CHILD}/release`);
    let observer;
    try {
      const session = (
        await api.createSession(
          create(pb.CreateSessionRequestSchema, {
            clientRequestId: id(),
            config: { modelRef: "chat" },
          }),
        )
      ).session;
      await api.setSessionTitle(
        create(pb.SetSessionTitleRequestSchema, {
          sessionId: session.sessionId,
          title: "Web fixture",
        }),
      );
      observer = await stream.subscribeSession(
        create(pb.SubscribeSessionRequestSchema, {
          sessionId: session.sessionId,
        }),
      );
      await observer.next();
      const start = async (text) =>
        (
          await api.startRun(
            create(pb.StartRunRequestSchema, {
              sessionId: session.sessionId,
              inputId: id(),
              input: [{ content: { case: "text", value: text } }],
            }),
          )
        ).run;
      const completed = async () => {
        while (true) {
          const { value, done } = await observer.next();
          assert.ok(!done, "missing RunCompleted");
          if (value.payload.case === "runCompleted") return value.payload.value.run;
        }
      };
      const run = async (text) => {
        await start(text);
        return completed();
      };
      const tools = (run) =>
        run.items
          .filter((item) => item.content.case === "toolCall")
          .map((item) => item.content.value);
      const provider = (run) => JSON.parse(tools(run)[0].metadataJson).webSearch.provider;
      let pipeline;
      await until(async () => {
        pipeline = await run("pipeline");
        return provider(pipeline) === "tavily";
      });
      const initialReads = runtimeReads;
      await run("search");
      assert.equal(runtimeReads, initialReads, "tool requests must not read settings");
      assert.equal(pipeline.status, pb.AgentRunStatus.COMPLETED);
      assert.deepEqual(
        tools(pipeline).map((tool) => tool.name),
        ["WebSearch", "WebFetch"],
      );
      assert.equal(provider(pipeline), "tavily");
      assert.ok(tools(pipeline)[1].output.includes("The answer is 42."));
      assert.equal(pipeline.items.filter((item) => item.content.case === "agentMessage").length, 1);
      const saveKey = (key) =>
        settings.update(
          create(pb.UpdateSettingsRequestSchema, {
            change: {
              case: "webSearchApiKey",
              value: { provider: pb.WebSearchProvider.TAVILY, apiKey: key },
            },
          }),
        );
      await saveKey("tavily-fixture-a");
      await settings.update(
        create(pb.UpdateSettingsRequestSchema, {
          change: { case: "webSearchProvider", value: pb.WebSearchProvider.TAVILY },
        }),
      );
      let switched;
      await until(async () => {
        switched = await run("search");
        return provider(switched) === "tavily";
      });
      const sameSchema = requests.filter((request) => request.model === "chat");
      const declaration = (request) =>
        request.tools.find((tool) => tool.function.name === "WebSearch");
      assert.deepEqual(declaration(sameSchema[0]), declaration(sameSchema.at(-1)));
      await saveKey("tavily-fixture-b");
      await until(async () => {
        await run("search");
        return (await state()).at(-1).key === "tavily-fixture-b";
      });
      const failedReadBefore = runtimeReads;
      failRuntimeReads = true;
      await settings.update(
        create(pb.UpdateSettingsRequestSchema, {
          change: { case: "webSearchProvider", value: pb.WebSearchProvider.BING },
        }),
      );
      await until(() => runtimeReads > failedReadBefore);
      assert.equal(provider(await run("search")), "tavily");
      failRuntimeReads = false;
      await settings.update(
        create(pb.UpdateSettingsRequestSchema, {
          change: { case: "webSearchProvider", value: pb.WebSearchProvider.TAVILY },
        }),
      );
      await until(() => runtimeReads > failedReadBefore + 1);
      const beforeHeld = (await state()).length;
      await start("hold");
      await until(async () => (await state()).length > beforeHeld);
      await settings.update(
        create(pb.UpdateSettingsRequestSchema, {
          change: { case: "webSearchProvider", value: pb.WebSearchProvider.BING },
        }),
      );
      await release();
      assert.equal(provider(await completed()), "tavily");
      await until(async () => provider(await run("search")) === "bing");
      for (const input of ["hold", "fetch-stop", "extract-stop"]) {
        const before = (await state()).length;
        const modelBefore = requests.length;
        hangExtraction = input === "extract-stop";
        const active = await start(input);
        await until(async () =>
          hangExtraction
            ? requests.slice(modelBefore).some((request) => request.model === "small")
            : (await state()).length > before,
        );
        await api.interruptRun(
          create(pb.InterruptRunRequestSchema, {
            sessionId: session.sessionId,
            runId: active.runId,
          }),
        );
        const stopped = await completed();
        assert.equal(stopped.status, pb.AgentRunStatus.INTERRUPTED);
        assert.equal(tools(stopped)[0].status, pb.AgentToolStatus.CANCELLED);
        hangExtraction = false;
        await release();
      }
      await saveKey("invalid-fixture-key");
      const tested = await settings.testWebSearchProvider(
        create(pb.TestWebSearchProviderRequestSchema, {
          provider: pb.WebSearchProvider.TAVILY,
        }),
      );
      assert.equal(tested.ok, false);
      assert.match(tested.error, /401/);
      await saveKey("");
      const snapshot = await settings.get(create(EmptySchema));
      assert.equal(snapshot.webSearch.effectiveProvider, pb.WebSearchProvider.BING);
      await observer.cancel();
      observer = undefined;
      const before = await api.readSession(
        create(pb.ReadSessionRequestSchema, {
          sessionId: session.sessionId,
          includeRuns: true,
        }),
      );
      const modelCount = requests.length;
      const networkCount = (await state()).length;
      await agent.close();
      await endpoint.close();
      agent = await Agent.open(join(root, "agent"));
      endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
      const restored = await api.readSession(
        create(pb.ReadSessionRequestSchema, {
          sessionId: session.sessionId,
          includeRuns: true,
        }),
      );
      assert.equal(restored.session.runs.length, before.session.runs.length);
      assert.deepEqual(
        restored.session.runs.map((run) => run.items),
        before.session.runs.map((run) => run.items),
      );
      assert.equal(requests.length, modelCount);
      assert.equal((await state()).length, networkCount);
      const journals = [];
      const visit = async (path) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) await visit(join(path, entry.name));
          else if (entry.name.endsWith(".jsonl"))
            journals.push(await readFile(join(path, entry.name), "utf8"));
        }
      };
      await visit(join(root, "agent"));
      assert.equal(journals.length, 1);
      assert.equal(
        journals[0].split("\n").filter((line) => line.includes('"system_context"')).length,
        1,
      );
      assert.ok(!journals[0].includes("tavily-fixture-"));
    } finally {
      await observer?.cancel().catch(() => {});
      await agent.close();
      await endpoint.close();
      await llm.close();
      auxiliary.close();
      await settingsEndpoint.close();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
