import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  EmptySchema,
  FinishReason,
  GenerateEventSchema,
  type GenerateRequest,
  Llm,
  ModelDefaultsSchema,
  ModelSettings,
  ModelSettingsChangedSchema,
  ModelSettingsSnapshotSchema,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers, bindStreamHandlers, type StreamHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { useQuickChat } from "./use-quick-chat";

afterEach(cleanup);

function finished(text = "answer") {
  return create(GenerateEventSchema, {
    event: {
      case: "finished",
      value: {
        reason: FinishReason.STOP,
        message: {
          api: "anthropic-messages",
          provider: "anthropic",
          modelId: "upstream",
          responseId: "response-1",
          content: [
            { content: { case: "thinking", value: { text: "reason", signature: "signature" } } },
            { content: { case: "text", value: { text } } },
          ],
          stopReason: FinishReason.STOP,
        },
      },
    },
  });
}

function fixture(generate: StreamHandlers<typeof Llm>["generate"], defaultModel = "model", get?: () => Promise<never>) {
  const host = new GatewayHost();
  let snapshot = create(ModelSettingsSnapshotSchema, {
    revision: 1n,
    defaults: { modelRef: defaultModel, thinkingLevel: "high" },
    providers: [{ id: "provider", models: [{ id: "model" }, { id: "other" }] }],
  });
  const owner = host.registerOwner(
    "settings",
    bindHandlers(ModelSettings, { get: () => get?.() ?? snapshot }, { partial: true }),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  host.registerOwner("llm", bindStreamHandlers(Llm, { generate, async *modelCatalog() {} }));
  const services = createServices(() => host.client({ caller: "test", trusted: true }));
  return {
    services,
    update(modelRef: string) {
      snapshot = create(ModelSettingsSnapshotSchema, {
        ...snapshot,
        revision: snapshot.revision + 1n,
        defaults: create(ModelDefaultsSchema, { modelRef, thinkingLevel: "low" }),
      });
      owner.publish(
        ModelSettingsChangedSchema.typeName,
        toBinary(ModelSettingsChangedSchema, create(ModelSettingsChangedSchema, { snapshot })),
      );
    },
  };
}

async function prompt(
  result: ReturnType<typeof renderHook<ReturnType<typeof useQuickChat>, unknown>>["result"],
  text: string,
) {
  act(() => result.current.onDraftChange(text));
  act(() => result.current.onSend());
}

test("default configuration drives generation; complete assistant metadata is replayed on the next turn", async () => {
  const requests: GenerateRequest[] = [];
  const app = fixture(async function* (request) {
    requests.push(request);
    yield create(GenerateEventSchema, { event: { case: "textDelta", value: { text: "partial" } } });
    yield finished();
  });
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  await prompt(result, "remember apple");
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(result.current.messages[1].text).toBe("answer");
  expect(requests[0].modelRef).toBe("model");
  expect(requests[0].options?.reasoning).toBe("high");
  expect(requests[0].tools).toEqual([]);
  act(() => app.update("other"));
  await waitFor(() => expect(result.current.configured).toBe(true));
  await prompt(result, "what did I say?");
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1].modelRef).toBe("other");
  expect(requests[1].options?.reasoning).toBe("low");
  expect(requests[1].messages.map((entry) => entry.message.case)).toEqual(["user", "assistant", "user"]);
  expect(requests[1].messages[1].message.value).toMatchObject({
    responseId: "response-1",
    content: [{ content: { case: "thinking", value: { signature: "signature" } } }, {}],
  });
  await waitFor(() => expect(result.current.generating).toBe(false));
  act(() => app.update(""));
  await waitFor(() => expect(result.current.error).toContain("未设置默认模型"));
  expect(result.current.messages).toHaveLength(4);
});

test("no default blocks requests; opening cancellation, clear and unmount abort the real Gateway stream", async () => {
  const requests: GenerateRequest[] = [];
  const aborted: string[] = [];
  const app = fixture(async (request, _client, signal) => {
    requests.push(request);
    const text =
      request.messages[0].message.case === "user"
        ? request.messages[0].message.value.content[0].content.value
        : undefined;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(String(text));
          resolve();
        },
        { once: true },
      ),
    );
    return (async function* () {
      yield finished("late reply");
    })();
  }, "");
  const { result, unmount } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await prompt(result, "blocked");
  expect(requests).toHaveLength(0);
  act(() => app.update("model"));
  await waitFor(() => expect(result.current.configured).toBe(true));
  act(() => {
    result.current.onSend();
    result.current.onSend();
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() => result.current.onNewConversation());
  await waitFor(() => expect(aborted).toHaveLength(1));
  expect(result.current.messages).toEqual([]);
  await prompt(result, "second");
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(result.current.generating).toBe(true);
  unmount();
  await waitFor(() => expect(aborted).toHaveLength(2));
});

test("stopping preserves partial display without replaying it; disconnects and tools are errors", async () => {
  let count = 0;
  const requests: GenerateRequest[] = [];
  const app = fixture(async function* (request, _client, signal) {
    requests.push(request);
    count++;
    if (count === 1) {
      yield create(GenerateEventSchema, { event: { case: "textDelta", value: { text: "partial" } } });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } else if (count === 2) {
      yield create(GenerateEventSchema, { event: { case: "textDelta", value: { text: "disconnected" } } });
    } else {
      yield create(GenerateEventSchema, { event: { case: "blockDelta", value: { kind: "toolcall", delta: "{}" } } });
    }
  });
  const { result } = renderHook(() => useQuickChat(app.services));
  await waitFor(() => expect(result.current.configured).toBe(true));
  await prompt(result, "first");
  await waitFor(() => expect(result.current.messages[1].text).toBe("partial"));
  act(() => result.current.onStop());
  expect(result.current.messages[1]).toMatchObject({ text: "partial", status: "cancelled" });
  await prompt(result, "second");
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(requests[1].messages.map((item) => item.message.case)).toEqual(["user", "user"]);
  expect(result.current.messages[3].error).toContain("中断");
  await prompt(result, "third");
  await waitFor(() => expect(result.current.generating).toBe(false));
  expect(result.current.messages[5].error).toContain("不支持工具调用");
});

for (const eventFirst of [true, false]) {
  test(`valid settings recover from initial read failure (event first: ${eventFirst})`, async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    const app = fixture(
      async function* () {
        yield finished();
      },
      "model",
      () =>
        new Promise<never>((_resolve, reject) => {
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
