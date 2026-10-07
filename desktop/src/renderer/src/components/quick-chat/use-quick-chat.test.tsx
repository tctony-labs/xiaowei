import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  AgentEventSchema,
  AgentModelConfigSchema,
  AgentRunStatus,
  CreateSessionRequestSchema,
  EmptySchema,
  ModelDefaultsSchema,
  ModelInfoWarningCode,
  ModelSettings,
  ModelSettingsChangedSchema,
  type ModelSettingsSnapshot,
  ModelSettingsSnapshotSchema,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { createServices } from "../../services";
import { AgentChatClient } from "../agent-chat/client";
import { agentIdentity } from "../agent-chat/identity";
import { agentFixture } from "../agent-chat/test-fixture";
import { useQuickChat } from "./use-quick-chat";

afterEach(cleanup);

function fixture(
  defaultModel = "model",
  providers?: ModelSettingsSnapshot["providers"],
  get?: () => Promise<never>,
  smallTextModelRef = "",
) {
  const agent = agentFixture();
  let snapshot = create(ModelSettingsSnapshotSchema, {
    revision: 1n,
    defaults: { modelRef: defaultModel, thinkingLevel: "high", smallTextModelRef },
    providers: providers ?? [{ id: "provider", models: [{ id: "model" }, { id: "other" }] }],
  });
  const owner = agent.host.registerOwner(
    "settings",
    bindHandlers(
      ModelSettings,
      {
        get: () => get?.() ?? snapshot,
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => agent.host.client({ caller: "quick-chat-test", trusted: true }));
  return {
    ...agent,
    agent,
    services,
    snapshot: () => snapshot,
    update(modelRef: string, providers = snapshot.providers, smallTextModelRef = snapshot.defaults?.smallTextModelRef) {
      snapshot = create(ModelSettingsSnapshotSchema, {
        ...snapshot,
        revision: snapshot.revision + 1n,
        defaults: create(ModelDefaultsSchema, { modelRef, thinkingLevel: "low", smallTextModelRef }),
        providers,
      });
      owner.publish(
        ModelSettingsChangedSchema.typeName,
        toBinary(ModelSettingsChangedSchema, create(ModelSettingsChangedSchema, { snapshot })),
      );
    },
  };
}

function prompt(result: { current: ReturnType<typeof useQuickChat> }, text: string) {
  act(() => result.current.onDraftChange(text));
  act(() => result.current.onSend());
}

test("startup restores the last updated unarchived session and remount preserves an explicit new chat", async () => {
  const app = fixture();
  const previous = new AgentChatClient(app.services);
  const detach = previous.observe(() => {});
  const config = create(AgentModelConfigSchema, { modelRef: "other", reasoning: "low" });
  await previous.send("older conversation", config);
  app.finish();
  await waitFor(() => expect(previous.busy).toBe(false));
  const first = app.sessions.get(previous.session?.sessionId ?? "");
  await previous.newConversation();
  await previous.send("newer conversation", config);
  app.finish();
  await waitFor(() => expect(previous.busy).toBe(false));
  const second = app.sessions.get(previous.session?.sessionId ?? "");
  const archived = (
    await app.services.getAgent().createSession(
      create(CreateSessionRequestSchema, {
        clientRequestId: agentIdentity(),
        config,
      }),
    )
  ).session;
  const archivedState = app.sessions.get(archived?.sessionId ?? "");
  if (!first || !second || !archivedState) throw new Error("Missing fixture sessions");
  first.createdAtMs = 1n;
  first.updatedAtMs = 300n;
  second.createdAtMs = 2n;
  second.updatedAtMs = 200n;
  archivedState.updatedAtMs = 400n;
  archivedState.archived = true;
  detach();

  // New Services creates a fresh renderer client, as after an application restart.
  const services = createServices(() => app.host.client({ caller: "restarted", trusted: true }));
  const restored = renderHook(() => useQuickChat(services));
  await waitFor(() => expect(restored.result.current.sessionId).toBe(first.sessionId));
  await waitFor(() => expect(restored.result.current.loading).toBe(false));
  expect(restored.result.current.messages[0].text).toBe("older conversation");
  expect(restored.result.current.messages[1].text).toBe("answer");
  expect(restored.result.current.selectedModelRef).toBe("other");
  expect(restored.result.current.reasoning).toBe("low");
  expect(app.requests).toHaveLength(2);
  expect(app.agent.counts.created).toBe(3);
  act(() => restored.result.current.onNewConversation());
  await waitFor(() => expect(restored.result.current.sessionId).toBeNull());
  restored.unmount();
  const remounted = renderHook(() => useQuickChat(services));
  await waitFor(() => expect(remounted.result.current.loading).toBe(false));
  expect(remounted.result.current.sessionId).toBeNull();
  expect(remounted.result.current.messages).toEqual([]);
});

test("startup with no unarchived sessions keeps a blank chat without creating a session", async () => {
  const app = fixture();
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  expect(result.current.sessionId).toBeNull();
  expect(result.current.messages).toEqual([]);
  expect(app.agent.counts.created).toBe(0);
});

test("default model drives Agent input; history comes from the session projection", async () => {
  const app = fixture();
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  prompt(result, "remember apple");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  expect(app.agent.session?.config).toMatchObject({ modelRef: "model", reasoning: "high" });
  expect(app.requests[0].config).toBeUndefined();
  expect(app.requests[0].input).toHaveLength(1);
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(result.current.messages[1]).toMatchObject({ text: "answer", thinking: "reason", status: "complete" });
  act(() => app.update("other"));
  await waitFor(() => expect(app.snapshot().defaults?.modelRef).toBe("other"));
  prompt(result, "what did I say?");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  expect(app.requests[1].config).toBeUndefined();
  expect(app.agent.session?.config).toMatchObject({ modelRef: "model", reasoning: "high" });
  expect(app.requests[1].sessionId).toBe(app.requests[0].sessionId);
  expect(app.requests[1].input[0].content.value).toBe("what did I say?");
  act(() => app.finish());
  await waitFor(() => expect(result.current.messages).toHaveLength(4));
});

test("Stop waits for terminal; new conversation retains history after settlement; unmount only disconnects", async () => {
  const app = fixture();
  const { result, unmount } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  prompt(result, "first");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  act(() => result.current.onStop());
  await waitFor(() => expect(app.agent.counts.interrupted).toBe(1));
  expect(result.current.generating).toBe(true);
  act(() => app.finish(AgentRunStatus.INTERRUPTED, "partial"));
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(result.current.messages[1]).toMatchObject({ text: "partial", status: "cancelled" });
  prompt(result, "second");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  act(() => result.current.onNewConversation());
  await waitFor(() => expect(app.agent.counts.interrupted).toBe(2));
  expect(app.agent.counts.deleted).toBe(0);
  act(() => app.finish(AgentRunStatus.INTERRUPTED));
  expect(app.agent.counts.deleted).toBe(0);
  await waitFor(() => expect(result.current.messages).toEqual([]));
  prompt(result, "third");
  await waitFor(() => expect(app.requests).toHaveLength(3));
  unmount();
  await waitFor(() => expect(app.agent.counts.observing).toBe(0));
  expect(app.agent.counts.interrupted).toBe(2);
  expect(app.agent.counts.created).toBe(2);
});

test("no models blocks send; restoring models and missing defaults use first available without updating settings", async () => {
  const app = fixture("", []);
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.loading).toBe(false));
  prompt(result, "blocked");
  expect(app.requests).toHaveLength(0);
  act(() =>
    app.update(
      "",
      create(ModelSettingsSnapshotSchema, {
        providers: [
          { id: "unavailable", unavailableReason: "missing", models: [{ id: "blocked" }] },
          { id: "available", models: [{ id: "first" }] },
        ],
      }).providers,
    ),
  );
  await waitFor(() => expect(result.current.configured).toBe(true));
  act(() => {
    result.current.onSend();
    result.current.onSend();
  });
  await waitFor(() => expect(app.requests).toHaveLength(1));
  expect(app.agent.session?.config?.modelRef).toBe("first");
  expect(app.agent.session?.config?.reasoning).toBeUndefined();
  expect(app.snapshot().defaults?.modelRef).toBe("");
  act(() => app.finish());
});

test("new conversation preserves sessions and drafts; selecting a session restores its messages", async () => {
  const app = fixture();
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  prompt(result, "first question");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  const firstId = app.requests[0].sessionId;
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  act(() => result.current.onDraftChange("first draft"));
  act(() => result.current.onNewConversation());
  await waitFor(() => expect(result.current.sessionId).toBeNull());
  expect(result.current.draft).toBe("");
  expect(app.agent.counts.deleted).toBe(0);
  prompt(result, "second question");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  const secondId = app.requests[1].sessionId;
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  act(() => result.current.onDraftChange("second draft"));
  act(() => result.current.onListSessions());
  await waitFor(() => expect(result.current.sessionsLoading).toBe(false));
  expect(result.current.sessions).toEqual(
    expect.arrayContaining([
      { id: firstId, title: "first question" },
      { id: secondId, title: "second question" },
    ]),
  );
  act(() => result.current.onSwitchSession(firstId));
  await waitFor(() => expect(result.current.sessionId).toBe(firstId));
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(result.current.messages[0].text).toBe("first question");
  expect(result.current.draft).toBe("first draft");
  prompt(result, "continue first");
  await waitFor(() => expect(app.requests).toHaveLength(3));
  expect(app.requests[2].sessionId).toBe(firstId);
  act(() => app.finish(AgentRunStatus.COMPLETED, "answer", "", firstId));
  await waitFor(() => expect(result.current.generating).toBe(false));
  act(() => result.current.onSwitchSession(secondId));
  await waitFor(() => expect(result.current.sessionId).toBe(secondId));
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.draft).toBe("second draft");
});

for (const eventFirst of [true, false]) {
  test(`valid settings recover from initial read failure (event first: ${eventFirst})`, async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    const app = fixture(
      "model",
      undefined,
      () =>
        new Promise<never>((_, reject) => {
          rejectRead = reject;
        }),
    );
    const { result } = renderHook(() => useQuickChat(app.services));
    await waitFor(() => expect(rejectRead).toBeDefined());
    if (eventFirst) {
      act(() => app.update("model"));
      await waitFor(() => expect(result.current.configured).toBe(true));
    }
    await act(async () => rejectRead?.(new Error("read failed")));
    if (!eventFirst) {
      await waitFor(() => expect(result.current.error).toContain("加载默认模型失败"));
      act(() => app.update("model"));
    }
    await waitFor(() => expect(result.current.configured).toBe(true));
    expect(result.current.error).toBe("");
  });
}

test("composer saves selection during a Run and preserves reasoning only when supported", async () => {
  const app = fixture(
    "model",
    create(ModelSettingsSnapshotSchema, {
      providers: [
        {
          id: "provider",
          name: "tctony",
          models: [
            { id: "model", name: "sol", reasoning: true, thinkingLevelMapJson: '{"high":"high","low":"low"}' },
            { id: "other", name: "luna", reasoning: true, thinkingLevelMapJson: '{"high":"high"}' },
            { id: "plain", name: "text", reasoning: false },
          ],
        },
      ],
    }).providers,
  );
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  expect(result.current.modelOptions[0].label).toBe("tctony/sol");
  prompt(result, "first");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  const runConfig = app.agent.session?.runs[0].config;
  act(() => result.current.onModelChange("other"));
  await waitFor(() => expect(result.current.selectedModelRef).toBe("other"));
  expect(result.current.reasoning).toBe("high");
  expect(app.agent.session?.runs[0].config).toEqual(runConfig);
  act(() => result.current.onModelChange("plain"));
  await waitFor(() => expect(result.current.selectedModelRef).toBe("plain"));
  expect(result.current.reasoning).toBe("");
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  prompt(result, "next");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  expect(app.requests[1].config).toBeUndefined();
  expect(app.agent.session?.runs[1].config?.modelRef).toBe("plain");
});

test("model warning persists through sending and clears only after a lookup success event", async () => {
  const app = fixture();
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  prompt(result, "first");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  const sessionId = result.current.sessionId ?? "";
  act(() =>
    app.emit(
      create(AgentEventSchema, {
        payload: {
          case: "sessionModelInfoWarningUpdated",
          value: {
            sessionId,
            providerName: "tctony",
            modelName: "sol",
            warning: { modelRef: "model", code: ModelInfoWarningCode.UNAVAILABLE },
          },
        },
      }),
    ),
  );
  await waitFor(() => expect(result.current.modelHint).toBe("tctony/sol 模型配置获取失败，部分功能可能出现异常"));
  expect(result.current.error).toBe("");
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  prompt(result, "send despite missing info");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  expect(result.current.modelHint).toContain("模型配置获取失败");
  act(() =>
    app.emit(
      create(AgentEventSchema, {
        payload: {
          case: "sessionModelInfoWarningUpdated",
          value: { sessionId, providerName: "tctony", modelName: "sol" },
        },
      }),
    ),
  );
  await waitFor(() => expect(result.current.modelHint).toBeUndefined());
});

test("failed selection save keeps the committed model and sending remains possible", async () => {
  const app = fixture();
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  prompt(result, "first");
  await waitFor(() => expect(app.requests).toHaveLength(1));
  act(() => app.finish());
  await waitFor(() => expect(result.current.generating).toBe(false));
  app.failNextConfig();
  act(() => result.current.onModelChange("other"));
  await waitFor(() => expect(result.current.configSaving).toBe(false));
  await waitFor(() => expect(result.current.error).toContain("保存会话模型设置失败"));
  expect(result.current.selectedModelRef).toBe("model");
  expect(result.current.configured).toBe(true);
  prompt(result, "continue original");
  await waitFor(() => expect(app.requests).toHaveLength(2));
  expect(app.agent.session?.runs[1].config?.modelRef).toBe("model");
});
