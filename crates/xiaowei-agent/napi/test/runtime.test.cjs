const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const { resolve, join } = require("node:path");
const { mkdtemp, rm, readdir, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { Agent } = require("xiaowei-agent");

function id() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("formal Agent addon reaches production worker; history, dual observers, failure, stop and close settle", {
  timeout: 30000,
}, async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient, bindStreamClient, bindHandlers } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const { attachWorker } = await import("xiaowei-gateway/worker-host");
  const requests = [];
  const disconnected = new Set();
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages.at(-1).content;
    const text = typeof content === "string" ? content : content[0].text;
    requests.push(body);
    outgoing.on("close", () => disconnected.add(text));
    if (text === "http-error") {
      outgoing.writeHead(401);
      outgoing.end("secret provider diagnostic");
      return;
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      outgoing.write(
        `data: ${JSON.stringify({
          id: "resp-test",
          model: "upstream",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    send({ role: "assistant", reasoning_content: "thinking" });
    send({ content: "partial" });
    if (text === "cancel" || text === "close") return;
    if (text === "eof") {
      outgoing.end();
      return;
    }
    send({ content: "-answer" });
    send({}, text === "length" ? "length" : "stop");
    outgoing.write("data: [DONE]\n\n");
    outgoing.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = new GatewayHost();
  const worker = new Worker(pathToFileURL(resolve(__dirname, "../../../../desktop/out/main/llm-worker.js")), {
    workerData: {
      models: [
        {
          id: "test",
          modelId: "upstream",
          name: "Test",
          api: "openai-completions",
          provider: "openai",
          providerName: "Test provider",
          reasoning: true,
          input: ["text"],
          maxTokens: 4096,
          contextWindow: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKey: "fixture",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          compat: { maxTokensField: "max_tokens" },
        },
      ],
    },
  });
  let llm;
  let endpoint;
  const root = await mkdtemp(join(tmpdir(), "agent-rollout-runtime-"));
  const agent = await Agent.open(root);
  let settings;
  let restored;
  let restoredEndpoint;
  try {
    llm = await attachWorker(host, "llm", worker);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const caller = host.client({ caller: "first-device", trusted: true });
    const api = bindClient(pb.Agent, caller);
    const streamApi = bindStreamClient(pb.Agent, caller);
    const other = bindStreamClient(pb.Agent, host.client({ caller: "second-device", trusted: true }));
    const config = { modelRef: "test" };
    const session = (
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: id(),
          config,
        }),
      )
    ).session;
    assert.equal(session.config.modelRef, "test");
    const observers = await Promise.all(
      [streamApi, other].map((client) =>
        client.subscribeSession(create(pb.SubscribeSessionRequestSchema, { sessionId: session.sessionId })),
      ),
    );
    for (const observer of observers) {
      const ready = (await observer.next()).value;
      assert.equal(ready.payload.case, "subscriptionReady");
      assert.equal(ready.payload.value.session.sessionId, session.sessionId);
    }
    const terminals = async (observer, runId) => {
      const events = [];
      while (true) {
        const { done, value: event } = await observer.next();
        if (done) throw new Error("missing run terminal");
        events.push(event);
        if (event.payload.case === "runCompleted" && event.payload.value.run.runId === runId) return events;
      }
    };
    const send = async (text, override, titleModelRef) => {
      const request = create(pb.StartRunRequestSchema, {
        sessionId: session.sessionId,
        inputId: id(),
        input: [{ content: { case: "text", value: text } }],
        config: override,
        titleModelRef,
      });
      const run = (await api.startRun(request)).run;
      const watching = observers.map((observer) => terminals(observer, run.runId));
      if (text === "cancel") {
        await until(
          () =>
            requests.at(-1)?.messages.at(-1).content?.[0]?.text === text ||
            requests.at(-1)?.messages.at(-1).content === text,
        );
        const stopped = await api.interruptRun(
          create(pb.InterruptRunRequestSchema, {
            sessionId: session.sessionId,
            runId: run.runId,
          }),
        );
        assert.equal(stopped.cancellationRequested, true);
      }
      const events = await Promise.all(watching);
      assert.deepEqual(
        events[0]
          .slice(events[0].findIndex((event) => event.payload.case === "runStarted"))
          .map((event) => event.payload.case),
        events[1]
          .slice(events[1].findIndex((event) => event.payload.case === "runStarted"))
          .map((event) => event.payload.case),
      );
      const final = events[0].at(-1).payload.value.run;
      const retry = await api.startRun(request);
      assert.equal(retry.run.runId, run.runId);
      return { final, events: events[0] };
    };
    const first = await send("first");
    assert.equal(first.final.status, pb.AgentRunStatus.COMPLETED);
    assert.ok(first.events.some((event) => event.payload.case === "reasoningDelta"));
    await send("second");
    assert.deepEqual(
      requests[1].messages.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(requests[1].messages[1].content, "partial-answer");
    assert.equal((await send("length")).final.status, pb.AgentRunStatus.COMPLETED);
    assert.equal((await send("eof")).final.status, pb.AgentRunStatus.FAILED);
    assert.equal((await send("http-error")).final.status, pb.AgentRunStatus.FAILED);
    assert.equal((await send("cancel")).final.status, pb.AgentRunStatus.INTERRUPTED);
    await until(() => disconnected.has("cancel"));
    await send("after-cancel");
    assert.equal(requests.at(-1).messages.filter((message) => message.role === "assistant").length, 3);
    const snapshot = await api.readSession(
      create(pb.ReadSessionRequestSchema, {
        sessionId: session.sessionId,
        includeRuns: true,
      }),
    );
    assert.equal(snapshot.session.runs.length, 7);
    const waitTitle = async (observer) => {
      while (true) {
        const { done, value } = await observer.next();
        if (done) throw new Error("missing title notification");
        if (value.payload.case === "sessionTitleUpdated") return value.payload.value;
      }
    };
    await assert.rejects(
      api.regenerateTitle(
        create(pb.RegenerateTitleRequestSchema, {
          sessionId: session.sessionId,
        }),
      ),
      (error) => error.detail.code === "HANDLER_ERROR",
    );
    let auxiliaryAvailable = true;
    settings = host.registerOwner(
      "settings",
      bindHandlers(
        pb.ModelSettings,
        {
          getAuxiliaryModelRef: () =>
            create(pb.AuxiliaryModelRefSchema, {
              modelRef: auxiliaryAvailable ? "test" : undefined,
            }),
        },
        { partial: true },
      ),
    );
    const manual = await api.regenerateTitle(
      create(pb.RegenerateTitleRequestSchema, {
        sessionId: session.sessionId,
        titleModelRef: "test",
      }),
    );
    assert.equal(manual.title, "partial-answer");
    const manualEvents = await Promise.all(observers.map(waitTitle));
    assert.deepEqual(manualEvents[0], manualEvents[1]);
    assert.ok(manualEvents[0].updatedAtMs > snapshot.session.updatedAtMs);
    assert.equal(requests.at(-1).max_tokens, 64);
    assert.equal(requests.at(-1).temperature, 0.8);
    // Pi maps the system instruction to developer for this reasoning model.
    assert.equal(requests.at(-1).messages[0].role, "developer");
    assert.equal(requests.at(-1).messages.length, 2);
    const automaticRun = await send("auto-title", undefined, "test");
    const automaticEvents = await Promise.all(observers.map(waitTitle));
    assert.deepEqual(automaticEvents[0], automaticEvents[1]);
    assert.equal(automaticEvents[0].title, "partial-answer");
    assert.equal(automaticEvents[0].autoTitleEnabled, true);
    assert.ok(automaticEvents[0].updatedAtMs > 0n);
    assert.equal(automaticEvents[0].updatedAtMs, automaticRun.final.completedAtMs);
    const afterAutomatic = (
      await api.readSession(
        create(pb.ReadSessionRequestSchema, {
          sessionId: session.sessionId,
        }),
      )
    ).session;
    assert.equal(afterAutomatic.updatedAtMs, automaticEvents[0].updatedAtMs);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const generationCount = requests.length;
    const setTitle = await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, {
        sessionId: session.sessionId,
        title: "  手写标题  ",
      }),
    );
    const setEvents = await Promise.all(observers.map(waitTitle));
    assert.deepEqual(setEvents[0], setEvents[1]);
    assert.equal(setTitle.title, "手写标题");
    assert.equal(setEvents[0].metadataRevision, setTitle.metadataRevision);
    assert.equal(setEvents[0].autoTitleEnabled, false);
    assert.ok(setEvents[0].updatedAtMs > afterAutomatic.updatedAtMs);
    assert.equal(
      (
        await api.readSession(
          create(pb.ReadSessionRequestSchema, {
            sessionId: session.sessionId,
          }),
        )
      ).session.updatedAtMs,
      setEvents[0].updatedAtMs,
    );
    assert.equal(requests.length, generationCount, "setting a title never invokes the model");
    assert.deepEqual(
      await api.setSessionTitle(
        create(pb.SetSessionTitleRequestSchema, {
          sessionId: session.sessionId,
          title: "手写标题",
        }),
      ),
      setTitle,
    );
    await assert.rejects(
      api.setSessionTitle(
        create(pb.SetSessionTitleRequestSchema, {
          sessionId: session.sessionId,
          title: "题".repeat(51),
        }),
      ),
      (error) => error.detail.code === "INVALID_ARGUMENT",
    );
    auxiliaryAvailable = false;
    await assert.rejects(
      api.regenerateTitle(create(pb.RegenerateTitleRequestSchema, { sessionId: session.sessionId })),
    );
    assert.equal(
      (await api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: session.sessionId }))).session
        .autoTitleEnabled,
      false,
    );
    assert.equal(
      (
        await api.readSession(
          create(pb.ReadSessionRequestSchema, {
            sessionId: session.sessionId,
          }),
        )
      ).session.updatedAtMs,
      setEvents[0].updatedAtMs,
    );
    await observers[1].cancel();
    const resumed = await other.subscribeSession(
      create(pb.SubscribeSessionRequestSchema, { sessionId: session.sessionId }),
    );
    const resumedSession = (await resumed.next()).value.payload.value.session;
    assert.equal(resumedSession.runs.length, 8);
    assert.equal(resumedSession.title, "手写标题");
    assert.equal(resumedSession.autoTitleEnabled, false);
    await resumed.cancel();
    await observers[0].cancel();
    // Creating and chatting in a second session must retain the first history.
    const secondSession = (
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: id(),
          config,
        }),
      )
    ).session;
    const secondObserver = await streamApi.subscribeSession(
      create(pb.SubscribeSessionRequestSchema, {
        sessionId: secondSession.sessionId,
      }),
    );
    assert.equal((await secondObserver.next()).value.payload.value.session.runs.length, 0);
    const secondRun = (
      await api.startRun(
        create(pb.StartRunRequestSchema, {
          sessionId: secondSession.sessionId,
          inputId: id(),
          input: [{ content: { case: "text", value: "independent-session" } }],
        }),
      )
    ).run;
    await terminals(secondObserver, secondRun.runId);
    assert.deepEqual(
      requests.at(-1).messages.map((message) => message.role),
      ["user"],
    );
    await secondObserver.cancel();
    const listed = await api.listSessions(create(pb.ListSessionsRequestSchema));
    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.sessions[0].sessionId, secondSession.sessionId);
    assert.ok(listed.sessions.every((session) => !("runs" in session)));
    assert.equal(listed.sessions[0].title, "independent-ses");
    assert.equal(listed.sessions.find((item) => item.sessionId === session.sessionId).title, "手写标题");
    assert.equal(listed.sessions.find((item) => item.sessionId === session.sessionId).autoTitleEnabled, false);
    const reopened = await streamApi.subscribeSession(
      create(pb.SubscribeSessionRequestSchema, {
        sessionId: session.sessionId,
      }),
    );
    const retained = (await reopened.next()).value.payload.value.session;
    assert.equal(retained.runs.length, 8);
    assert.equal(retained.title, "手写标题");
    assert.equal(retained.autoTitleEnabled, false);
    auxiliaryAvailable = true;
    await api.regenerateTitle(create(pb.RegenerateTitleRequestSchema, { sessionId: session.sessionId }));
    assert.equal((await waitTitle(reopened)).autoTitleEnabled, true);
    assert.equal(
      (await api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: session.sessionId }))).session
        .autoTitleEnabled,
      true,
    );
    auxiliaryAvailable = false;
    await reopened.cancel();
    const secondMeta = listed.sessions.find((item) => item.sessionId === secondSession.sessionId);
    await api.deleteSession(
      create(pb.DeleteSessionRequestSchema, {
        targets: [
          {
            sessionId: secondSession.sessionId,
            expectedMetadataRevision: secondMeta.metadataRevision,
          },
        ],
      }),
    );
    assert.deepEqual(
      (await api.listSessions(create(pb.ListSessionsRequestSchema))).sessions.map((item) => item.sessionId),
      [session.sessionId],
    );
    const closingRun = await api.startRun(
      create(pb.StartRunRequestSchema, {
        sessionId: session.sessionId,
        inputId: id(),
        input: [{ content: { case: "text", value: "close" } }],
      }),
    );
    assert.equal(closingRun.run.status, pb.AgentRunStatus.IN_PROGRESS);
    await until(
      () =>
        requests.at(-1)?.messages.at(-1).content?.[0]?.text === "close" ||
        requests.at(-1)?.messages.at(-1).content === "close",
    );
    await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, {
        sessionId: session.sessionId,
        title: "运行中设置的标题",
      }),
    );
    const running = (
      await api.readSession(
        create(pb.ReadSessionRequestSchema, {
          sessionId: session.sessionId,
          includeRuns: true,
        }),
      )
    ).session;
    assert.equal(running.title, "运行中设置的标题");
    assert.equal(running.status, pb.AgentSessionStatus.RUNNING);
    assert.equal(running.runs.at(-1).runId, closingRun.run.runId);
    assert.equal(running.runs.at(-1).status, pb.AgentRunStatus.IN_PROGRESS);
    assert.equal(disconnected.has("close"), false, "setting title must not cancel the active generation");
    await Promise.all([agent.close(), agent.close()]);
    await until(() => disconnected.has("close"));
    await assert.rejects(api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: session.sessionId })));
    await endpoint.close();
    endpoint = undefined;
    restored = await Agent.open(root);
    restoredEndpoint = await attachRustNapi(host, "restored-agent", restored.createGatewayEndpoint());
    const restoredSession = (
      await api.readSession(
        create(pb.ReadSessionRequestSchema, {
          sessionId: session.sessionId,
          includeRuns: true,
        }),
      )
    ).session;
    assert.equal(restoredSession.title, "运行中设置的标题");
    assert.equal(restoredSession.autoTitleEnabled, false);
    assert.equal(restoredSession.providerName, "Test provider");
    assert.equal(restoredSession.modelName, "Test");
    assert.equal(restoredSession.runs.length, 9);
    assert.equal(restoredSession.runs.at(-1).status, pb.AgentRunStatus.INTERRUPTED);
    assert.equal((await api.listSessions(create(pb.ListSessionsRequestSchema))).sessions.length, 1);
    // Real worker packet time traverses PB, the native Host adapter and the journal unchanged.
    const years = await readdir(join(root, "sessions"));
    const months = await readdir(join(root, "sessions", years[0]));
    const records = (await readFile(join(root, "sessions", years[0], months[0], `${session.sessionId}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records[0].payload, { type: "session_header" });
    assert.equal(records[1].payload.type, "meta");
    assert.equal(records[1].payload.data.provider_name, "Test provider");
    assert.equal(records[1].payload.data.model_name, "Test");
    for (const [index, record] of records.entries()) {
      assert.equal("session_id" in record, index === 0);
      assert.equal("schema_version" in record, index === 0);
      assert.equal("sequence" in record, false);
      assert.notEqual(record.payload.type, "context_defined");
      if (record.payload.type === "meta") {
        assert.ok(
          Object.keys(record.payload.data).every((key) =>
            ["model_ref", "reasoning", "provider_name", "model_name"].includes(key),
          ),
        );
      }
      if (record.payload.type === "run_started") {
        assert.ok(record.payload.data.context.model.model_ref);
        assert.equal("system_prompt" in record.payload.data.context, false);
      }
      if (record.payload.type === "gen_started") {
        assert.equal("context" in record.payload.data, false);
      }
    }

    assert.ok(records.some((entry) => entry.payload.type === "gen_first_sse_received"));
    const metadata = records.filter((entry) => entry.payload.type === "meta");
    assert.equal(metadata.length, 1, "unchanged model selection must not append another Meta");
    for (const entry of metadata) {
      assert.equal(Object.hasOwn(entry.payload.data, "archived"), false);
    }
  } finally {
    await agent.close();
    await endpoint?.close();
    await restored?.close();
    await restoredEndpoint?.close();
    settings?.close();
    await llm?.close();
    await worker.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
