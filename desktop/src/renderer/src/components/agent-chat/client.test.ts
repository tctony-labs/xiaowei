import { create } from "@bufbuild/protobuf";
import { waitFor } from "@testing-library/react";
import {
  AgentEventSchema,
  AgentInteractionStatus,
  AgentItemField,
  AgentModelConfigSchema,
  AgentPermissionRequestSchema,
  AgentQuestionSchema,
  AgentRunStatus,
  AgentSessionSchema,
  AgentToolStatus,
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  type ReadItemContentResponse,
  ReadItemContentResponseSchema,
  type ReadRunItemsResponse,
  ReadRunItemsResponseSchema,
  type ReadSessionResponse,
  ReadSessionResponseSchema,
} from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { createServices } from "../../services";
import { AgentChatClient, agentChatClient } from "./client";
import { agentIdentity } from "./identity";
import { agentFixture } from "./test-fixture";

const config = create(AgentModelConfigSchema, { modelRef: "test" });

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

test("failed startup lookup releases initialization and never creates or sends a conversation", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  fixture.failNextList();
  await expect(client.restoreLatestSession()).rejects.toThrow("disconnected");
  expect(client.initializing).toBe(false);
  expect(client.busy).toBe(false);
  expect(client.session).toBeUndefined();
  expect(client.error).toContain("disconnected");
  expect(fixture.counts.created).toBe(0);
  expect(fixture.requests).toEqual([]);
});

test("new conversation on a blank chat is a no-op and retains its draft and feedback", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const listener = vi.fn();
  const close = client.observe(listener);
  client.setDraft("old draft");
  client.error = "existing feedback";
  listener.mockClear();
  const opening = client.newConversation();
  expect(client.busy).toBe(false);
  expect(client.draft).toBe("old draft");
  expect(client.error).toBe("existing feedback");
  expect(listener).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
  client.setDraft("new typing");
  await opening;
  expect(client.draft).toBe("new typing");
  expect(fixture.counts.created).toBe(0);
  expect(fixture.counts.deleted).toBe(0);
  close();
});

test("new conversation preserves an existing empty session and its observation", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const response = await services
    .getAgent()
    .createSession(
      create(CreateSessionRequestSchema, { clientRequestId: agentIdentity(), config }),
    );
  const client = new AgentChatClient(services);
  const listener = vi.fn();
  const close = client.observe(listener);
  await client.switchSession(response.session?.sessionId ?? "");
  client.setDraft("keep this draft");
  const session = client.session;
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  listener.mockClear();
  await client.newConversation();
  expect(client.session).toBe(session);
  expect(client.draft).toBe("keep this draft");
  expect(client.busy).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
  expect(fixture.counts).toMatchObject({ created: 1, deleted: 0, interrupted: 0, observing: 1 });
  close();
});

test("setting a manual title synchronizes both observers and invalid titles leave it unchanged", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "first", trusted: true }));
  const otherServices = createServices(() =>
    fixture.host.client({ caller: "other", trusted: true }),
  );
  const client = new AgentChatClient(services);
  const other = new AgentChatClient(otherServices);
  const firstClose = client.observe(() => {});
  const otherClose = other.observe(() => {});
  await client.send("question", config);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await other.switchSession(client.session?.sessionId ?? "");
  await client.setTitle("  手写标题  ");
  await waitFor(() => expect(other.session?.title).toBe("手写标题"));
  expect(client.session?.autoTitleEnabled).toBe(false);
  expect(other.session?.autoTitleEnabled).toBe(false);
  expect(other.session?.metadataRevision).toBe(client.session?.metadataRevision);
  await client.listSessions();
  expect(client.sessions[0]).toMatchObject({ title: "手写标题", autoTitleEnabled: false });
  const revision = client.session?.metadataRevision;
  await expect(client.setTitle("题".repeat(51))).rejects.toThrow("1～50");
  expect(client.error).toContain("1～50");
  expect(client.session?.title).toBe("手写标题");
  expect(client.session?.metadataRevision).toBe(revision);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.titleRequests).toEqual([]);
  firstClose();
  otherClose();
});

test("a delayed regeneration reply cannot replace a more recent manual title", async () => {
  const fixture = agentFixture();
  const base = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const api = base.getAgent();
  const response = deferred<void>();
  const regenerateTitle: typeof api.regenerateTitle = (request) => {
    const rpc = api.regenerateTitle(request);
    return Object.assign(
      rpc.then(async (result) => {
        await response.promise;
        return result;
      }),
      { cancel: () => rpc.cancel() },
    );
  };
  const services = { ...base, getAgent: () => ({ ...api, regenerateTitle }) };
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("generate a title", config);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));

  const generation = client.regenerateTitle();
  await waitFor(() => expect(client.session?.title).toBe("生成的标题"));
  await client.setTitle("手写标题");
  await waitFor(() => expect(client.session?.title).toBe("手写标题"));
  response.resolve();
  await generation;

  expect(client.session?.title).toBe("手写标题");
  expect(client.session?.autoTitleEnabled).toBe(false);
  close();
});

test("a failed list refresh preserves the current chat and can be retried", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("keep visible", config);
  const sessionId = client.session?.sessionId;
  fixture.failNextList();
  await expect(client.listSessions()).rejects.toThrow("disconnected");
  expect(client.sessionsLoading).toBe(false);
  expect(client.session?.sessionId).toBe(sessionId);
  expect(client.messages[0].text).toBe("keep visible");
  expect(client.error).toContain("加载会话列表失败");
  await client.listSessions();
  expect(client.error).toBe("");
  expect(client.sessions).toHaveLength(1);
  close();
});

test("UUIDv7 IDs have canonical timestamps, variants and independent randomness", () => {
  const identities = Array.from({ length: 1000 }, agentIdentity);
  expect(new Set(identities).size).toBe(1000);
  for (const id of identities) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(
      Math.abs(Number.parseInt(id.slice(0, 13).replace("-", ""), 16) - Date.now()),
    ).toBeLessThan(1000);
  }
});

test("one client per Services survives disconnect and remount without duplicating or stopping runs", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = agentChatClient(services);
  expect(agentChatClient(services)).toBe(client);
  const detach = client.observe(() => {});
  await client.send("hello", config);
  await waitFor(() => expect(client.messages).toHaveLength(2));
  detach();
  await waitFor(() => expect(fixture.counts.observing).toBe(0));
  expect(fixture.counts.interrupted).toBe(0);
  fixture.finish(AgentRunStatus.COMPLETED, "finished while hidden");
  const unsubscribe = client.observe(() => {});
  await waitFor(() =>
    expect(client.messages[1].blocks).toContainEqual(
      expect.objectContaining({ kind: "text", text: "finished while hidden" }),
    ),
  );
  expect(fixture.counts.created).toBe(1);
  expect(fixture.requests).toHaveLength(1);
  unsubscribe();
});

test("lost response queries acceptance without resend and syncs both observers", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const first = client.observe(() => {});
  const second = client.observe(() => {});
  fixture.loseResponse();
  await client.send("once", config);
  expect(fixture.requests).toHaveLength(1);
  expect(client.messages.filter((message) => message.role === "user")).toHaveLength(1);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  first();
  expect(fixture.counts.observing).toBe(1);
  second();
  await waitFor(() => expect(fixture.counts.observing).toBe(0));
});

test("new conversation settles the run and preserves the old session for switching", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const close = client.observe(() => {});
  await client.send("hello", config);
  const previousId = client.session?.sessionId ?? "";
  const reset = client.newConversation();
  await waitFor(() => expect(fixture.counts.interrupted).toBe(1));
  await expect(client.deleteConversation()).rejects.toThrow("会话操作进行中");
  expect(fixture.counts.deleted).toBe(0);
  fixture.finish(AgentRunStatus.INTERRUPTED);
  await reset;
  expect(debug).toHaveBeenCalledWith(
    `Agent new conversation opened previous_session=${previousId}`,
  );
  expect(client.messages).toEqual([]);
  expect(fixture.counts.deleted).toBe(0);
  await client.send("new", config);
  expect(fixture.counts.created).toBe(2);
  await client.listSessions();
  expect(client.sessions).toHaveLength(2);
  await client.switchSession(previousId);
  expect(debug).toHaveBeenCalledWith(`Agent session switched session=${previousId}`);
  expect(client.messages[0].text).toBe("hello");
  expect(client.messages[1].status).toBe("cancelled");
  close();
});

test("unknown acceptance retains original input and blocks a fresh-ID resend until reset", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  fixture.failBeforeAcceptance();
  await expect(client.send("uncertain", config)).rejects.toThrow("发送结果尚未确认");
  expect(client.busy).toBe(true);
  expect(client.messages[0].text).toBe("uncertain");
  await expect(client.send("uncertain", config)).rejects.toThrow("Conversation busy");
  expect(fixture.requests).toHaveLength(1);
  await client.newConversation();
  expect(client.busy).toBe(false);
  expect(client.messages).toEqual([]);
  close();
});

test("a disconnected observation resubscribes once using a fresh authoritative snapshot", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("hello", config);
  await waitFor(() => expect(fixture.counts.interactionsObserving).toBe(1));
  fixture.disconnectObservers();
  fixture.finish(AgentRunStatus.COMPLETED, "settled during reconnection");
  await waitFor(() => expect(fixture.counts.disconnected).toBe(1));
  await waitFor(() =>
    expect(client.messages[1].blocks).toContainEqual(
      expect.objectContaining({ kind: "text", text: "settled during reconnection" }),
    ),
  );
  expect(client.error).toBe("");
  expect(fixture.requests).toHaveLength(1);
  fixture.disconnectObservers();
  await waitFor(() => expect(fixture.counts.disconnected).toBe(2));
  await waitFor(() => expect(client.error).toContain("请重试操作"));
  expect(fixture.counts.observing).toBe(0);
  await waitFor(() => expect(fixture.counts.interactionsObserving).toBe(0));
  close();
});

test("answers after observation failure reconnect before submitting", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("ask", config);
  const question = fixture.openInteraction({
    case: "question",
    value: create(AgentQuestionSchema, { question: "如何继续？" }),
  });
  await waitFor(() => expect(client.pendingQuestion?.interactionId).toBe(question.interactionId));
  client.setInteractionText(question.interactionId, "继续");
  fixture.disconnectObservers();
  await waitFor(() => expect(fixture.counts.disconnected).toBe(1));
  await waitFor(() => expect(fixture.counts.observing).toBe(1));
  fixture.disconnectObservers();
  await waitFor(() => expect(client.error).toContain("请重试操作"));
  await client.respondInteraction(question.interactionId);
  await waitFor(() =>
    expect(client.interaction(question.interactionId)?.status).toBe(
      AgentInteractionStatus.RESOLVED,
    ),
  );
  expect(fixture.interactionRequests).toHaveLength(1);
  expect(fixture.requests).toHaveLength(1);
  close();
});

test("uncertain permission retries retain the request ID and original decision", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("permission", config);
  const permission = fixture.openInteraction({
    case: "permission",
    value: create(AgentPermissionRequestSchema, { path: "/test-only/file", reason: "test" }),
  });
  await waitFor(() => expect(client.interaction(permission.interactionId)).toBeDefined());
  fixture.failNextInteractionBeforeAcceptance();
  await client.respondInteraction(permission.interactionId, true);
  expect(client.interactionForm(permission.interactionId).uncertain).toBe(true);
  await client.respondInteraction(permission.interactionId, false);
  expect(fixture.interactionRequests).toHaveLength(2);
  expect(fixture.interactionRequests[1]).toEqual(fixture.interactionRequests[0]);
  await waitFor(() =>
    expect(client.interaction(permission.interactionId)?.answer?.answer).toMatchObject({
      case: "permission",
      value: { allow: true },
    }),
  );
  close();
});

test("another caller deleting an uncertain session releases its pending input without resending", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  fixture.failBeforeAcceptance();
  await expect(client.send("uncertain", config)).rejects.toThrow();
  expect(client.busy).toBe(true);
  await services.getAgent().deleteSession(
    create(DeleteSessionRequestSchema, {
      targets: [
        {
          sessionId: client.session?.sessionId,
          expectedMetadataRevision: client.session?.metadataRevision,
        },
      ],
    }),
  );
  await waitFor(() => expect(client.busy).toBe(false));
  expect(client.messages).toEqual([]);
  expect(fixture.requests).toHaveLength(1);
  close();
});

test("switching never interrupts another session and restores its latest history and title", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("first", config);
  const firstId = client.session?.sessionId ?? "";
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await client.newConversation();
  await client.send("second", config);
  const secondId = client.session?.sessionId ?? "";
  client.setDraft("second draft");
  await client.switchSession(firstId);
  expect(client.draft).toBe("");
  expect(client.messages[0].text).toBe("first");
  expect(client.busy).toBe(false);
  expect(fixture.counts.interrupted).toBe(0);
  fixture.finish(AgentRunStatus.COMPLETED, "second finished offscreen", "", secondId);
  fixture.updateTitle("第二个标题", "small", secondId);
  expect(client.messages[1].blocks).toContainEqual(
    expect.objectContaining({ kind: "text", text: "answer" }),
  );
  await client.listSessions();
  expect(client.sessions.map((session) => session.sessionId)).toContain(secondId);
  await client.switchSession(secondId);
  expect(client.draft).toBe("second draft");
  expect(client.messages[1].blocks).toContainEqual(
    expect.objectContaining({ kind: "text", text: "second finished offscreen" }),
  );
  expect(client.session?.title).toBe("第二个标题");
  expect(fixture.counts.deleted).toBe(0);
  await waitFor(() => expect(fixture.counts.observing).toBe(1));
  close();
});

test("deletion removes only the selected session, while a missing switch preserves the current view", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("keep", config);
  const keptId = client.session?.sessionId ?? "";
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await client.newConversation();
  await client.send("delete", config);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await client.deleteConversation();
  expect(fixture.counts.deleted).toBe(1);
  await client.listSessions();
  expect(client.sessions.map((session) => session.sessionId)).toEqual([keptId]);
  await client.switchSession(keptId);
  await expect(client.switchSession(agentIdentity())).rejects.toThrow("会话已不存在");
  expect(client.session?.sessionId).toBe(keptId);
  expect(client.messages[0].text).toBe("keep");
  close();
});

test("an uncertain input remains attached to its session after switching away and back", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("known", config);
  const knownId = client.session?.sessionId ?? "";
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await client.newConversation();
  fixture.failBeforeAcceptance();
  await expect(client.send("uncertain", config)).rejects.toThrow();
  const uncertainId = client.session?.sessionId ?? "";
  await client.switchSession(knownId);
  expect(client.busy).toBe(false);
  await client.switchSession(uncertainId);
  expect(client.messages[0].text).toBe("uncertain");
  expect(client.busy).toBe(true);
  expect(client.error).toContain("发送结果尚未确认");
  expect(fixture.requests).toHaveLength(2);
  close();
});

test("Quick Chat lists only ordinary sessions after archiving the current conversation", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("archive this", config);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  const firstId = client.session?.sessionId ?? "";
  await client.archiveSession(firstId, true);
  expect(client.session).toBeUndefined();
  await client.listSessions();
  expect(client.sessions).toEqual([]);
  await client.send("keep active", config);
  const activeId = client.session?.sessionId;
  expect(client.sessions.map((session) => session.sessionId)).toEqual([activeId]);
  fixture.finish();
  await waitFor(() => expect(client.busy).toBe(false));
  await client.deleteConversation();
  expect(client.session).toBeUndefined();
  expect(client.sessions).toEqual([]);
  close();
});

test("older history merges into the live stream and an Item page survives completion", async () => {
  const history = deferred<ReadSessionResponse>();
  const items = deferred<ReadRunItemsResponse>();
  const fixture = agentFixture(undefined, {
    readSessionRuns: () => history.promise,
    readRunItems: () => items.promise,
  });
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("current", config);
  await waitFor(() => expect(client.session?.runs).toHaveLength(1));
  const session = client.session;
  if (!session) throw new Error("Missing session");
  const live = session.runs[0];
  session.runsContinuation = "older-runs";
  live.itemsContinuation = "older-items";
  live.itemsContinuationIsOlder = true;
  live.items[0].historyIndex = 0;

  const olderRun = { runId: agentIdentity(), inputId: agentIdentity() };
  const runPage = create(ReadSessionResponseSchema, {
    found: true,
    session: { sessionId: session.sessionId, title: "obsolete", runs: [olderRun] },
  });
  const extra = create(ReadRunItemsResponseSchema, {
    items: [
      {
        itemId: agentIdentity(),
        historyIndex: 1,
        content: { case: "reasoning", value: { text: "older process" } },
      },
    ],
  });

  const loadingRuns = client.loadOlderRuns();
  const loadingItems = client.loadRunItems(live.runId);
  fixture.finish();
  await waitFor(() => expect(client.session?.runs[0].status).toBe(AgentRunStatus.COMPLETED));
  history.resolve(runPage);
  items.resolve(extra);
  await Promise.all([loadingRuns, loadingItems]);
  expect(client.session?.title).not.toBe("obsolete");
  expect(client.session?.runs.map(({ runId }) => runId)).toEqual([olderRun.runId, live.runId]);
  expect(client.session?.runs[1].items).toContainEqual(extra.items[0]);
  expect(client.session?.runs[1].itemsContinuation).toBe("");
  close();
});

test("a page read before Continue preserves live recovery on the original run", async () => {
  const response = deferred<ReadRunItemsResponse>();
  const fixture = agentFixture(undefined, { readRunItems: () => response.promise });
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("original input", config);
  fixture.finish(AgentRunStatus.INTERRUPTED);
  await waitFor(() => expect(client.busy).toBe(false));
  const session = client.session;
  if (!session) throw new Error("Missing session");
  const [original] = session.runs;
  original.items = original.items.slice(0, 1);
  original.itemsContinuation = "more-process";
  const continuationId = agentIdentity();
  const settled = {
    itemId: agentIdentity(),
    historyIndex: 2,
    content: {
      case: "toolCall" as const,
      value: { name: "Bash", status: AgentToolStatus.RESULT_UNKNOWN },
    },
  };
  const loading = client.loadRunItems(original.runId);
  fixture.emit(
    create(AgentEventSchema, {
      payload: {
        case: "itemCompleted",
        value: { sessionId: session.sessionId, runId: original.runId, item: settled },
      },
    }),
  );
  fixture.emit(
    create(AgentEventSchema, {
      payload: {
        case: "runStarted",
        value: {
          sessionId: session.sessionId,
          run: {
            runId: continuationId,
            status: AgentRunStatus.IN_PROGRESS,
            continuedFromRunId: original.runId,
          },
        },
      },
    }),
  );
  await waitFor(() => expect(client.session?.runs).toHaveLength(2));
  const reasoningId = agentIdentity();
  response.resolve(
    create(ReadRunItemsResponseSchema, {
      items: [
        {
          itemId: reasoningId,
          historyIndex: 1,
          content: { case: "reasoning", value: { text: "prior process" } },
        },
        {
          ...settled,
          content: {
            case: "toolCall",
            value: { name: "Bash", status: AgentToolStatus.PENDING },
          },
        },
      ],
    }),
  );
  await loading;

  const [updated, continuation] = client.session?.runs ?? [];
  expect(updated.items.map((item) => item.itemId)).toEqual([
    original.items[0].itemId,
    reasoningId,
    settled.itemId,
  ]);
  expect(updated.items[2].content).toMatchObject(settled.content);
  expect(continuation.items).toEqual([]);
  expect(client.messages.map(({ role }) => role)).toEqual(["user", "assistant", "assistant"]);
  close();
});

test.each(["压缩摘要为空。", "会话记录写入失败。"])(
  "compaction failure preserves prior history and releases the composer (%s)",
  async (error) => {
    const fixture = agentFixture();
    const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
    const client = new AgentChatClient(services);
    const close = client.observe(() => {});
    await client.send("previous input", config);
    fixture.finish(AgentRunStatus.COMPLETED, "previous response");
    await waitFor(() => expect(client.busy).toBe(false));
    await client.send("trigger compaction", config);
    const sessionId = client.session?.sessionId ?? "";
    const run = fixture.sessions.get(sessionId)?.runs.at(-1);
    if (!run?.generation) throw new Error("Missing active generation");
    fixture.emit(
      create(AgentEventSchema, {
        payload: {
          case: "generationUpdated",
          value: {
            sessionId,
            runId: run.runId,
            generation: { ...run.generation, isCompaction: true },
          },
        },
      }),
    );
    await waitFor(() => expect(client.messages.at(-1)?.generation?.isCompaction).toBe(true));
    run.error = error;
    fixture.finish(AgentRunStatus.FAILED, "", "");
    await waitFor(() => expect(client.busy).toBe(false));

    expect(client.messages[1].blocks).toContainEqual(
      expect.objectContaining({ kind: "text", text: "previous response" }),
    );
    expect(client.messages.at(-1)).toMatchObject({ status: "failed", error });
    expect(client.messages.at(-1)?.generation).toBeUndefined();
    await client.send("try again", config);
    expect(fixture.requests).toHaveLength(3);
    close();
  },
);

test("full content joins byte chunks and a stale answer cannot change the current session", async () => {
  const chunk = deferred<ReadItemContentResponse>();
  const offsets: bigint[] = [];
  const fixture = agentFixture(undefined, {
    readItemContent(request) {
      offsets.push(request.offset);
      if (offsets.length === 1) {
        return create(ReadItemContentResponseSchema, { text: "中", nextOffset: 3n });
      }
      if (offsets.length === 2) return create(ReadItemContentResponseSchema, { text: "🙂" });
      return chunk.promise;
    },
  });
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const sessionId = agentIdentity();
  const runId = agentIdentity();
  const itemId = agentIdentity();
  client.session = create(AgentSessionSchema, {
    sessionId,
    runs: [
      {
        runId,
        items: [
          {
            itemId,
            shortenedFields: [AgentItemField.TEXT],
            content: { case: "agentMessage", value: { text: "中" } },
          },
        ],
      },
    ],
  });
  expect(
    (await client.loadItemContent(runId, itemId, [AgentItemField.TEXT])).get(AgentItemField.TEXT),
  ).toBe("中🙂");
  expect(offsets).toEqual([0n, 3n]);
  expect(client.session.runs[0].items[0].shortenedFields).toEqual([]);

  const loading = client.loadItemContent(runId, itemId, [AgentItemField.TEXT]);
  client.session = create(AgentSessionSchema, { sessionId: agentIdentity() });
  const assertion = expect(loading).rejects.toThrow("Observation replaced");
  chunk.resolve(create(ReadItemContentResponseSchema, { text: "old" }));
  await assertion;
  expect(client.session.runs).toEqual([]);
});

test("queued input and subsequent actions follow the authoritative session events", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});

  await client.send("first", config);
  await waitFor(() => expect(client.activeRunId).toBeTruthy());
  await client.queueInput("queued");
  await waitFor(() => expect(client.session?.queuedInputs).toHaveLength(1));
  const id = client.session?.queuedInputs[0].inputId ?? "";

  await client.changeQueuedInput("edit", id, "edited");
  await waitFor(() =>
    expect(client.session?.queuedInputs[0].input[0].content).toMatchObject({
      case: "text",
      value: "edited",
    }),
  );
  await client.changeQueuedInput("steer", id);
  await waitFor(() => expect(client.session?.queuedInputs[0].mode).toBe(2));
  await client.changeQueuedInput("remove", id);
  await waitFor(() => expect(client.session?.queuedInputs).toHaveLength(0));
  close();
});

test("lost queue acknowledgement is reconciled without creating a second input", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("first", config);
  await waitFor(() => expect(client.activeRunId).toBeTruthy());
  fixture.loseQueueResponse();
  await expect(client.queueInput("queued")).resolves.toBeTruthy();
  expect(client.session?.queuedInputs).toHaveLength(1);
  expect(client.hasUncertainQueueInput).toBe(false);
  close();
});

test("a second Enter while steering acknowledgement is pending requests interrupt", async () => {
  const fixture = agentFixture();
  const services = createServices(() => fixture.host.client({ caller: "test", trusted: true }));
  const client = new AgentChatClient(services);
  const close = client.observe(() => {});
  await client.send("first", config);
  await waitFor(() => expect(client.activeRunId).toBeTruthy());
  await client.queueInput("queued");
  await waitFor(() => expect(client.session?.queuedInputs).toHaveLength(1));
  const id = client.session?.queuedInputs[0].inputId ?? "";
  const release = fixture.holdSteerResponse();
  const first = client.steerQueuedInput(id);
  await waitFor(() => expect(client.session?.queuedInputs[0].mode).toBe(2));
  await client.interruptQueuedInput(id);
  release();
  await first;
  await waitFor(() => expect(client.session?.queuedInputs[0].mode).toBe(3));
  close();
});
