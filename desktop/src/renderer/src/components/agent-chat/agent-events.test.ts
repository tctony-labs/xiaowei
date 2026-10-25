import { create } from "@bufbuild/protobuf";
import { expect, test } from "vitest";
import {
  AgentEventSchema,
  AgentRunStatus,
  type AgentSession,
  AgentSessionSchema,
  AgentToolStatus,
} from "xiaowei-contracts";
import { applyAgentEvent, chatMessages } from "./agent-events";

test("title updates advance activity time and delayed run settlement cannot move it backwards", () => {
  let state: AgentSession | undefined = create(AgentSessionSchema, {
    sessionId: "s",
    updatedAtMs: 100n,
    runs: [{ runId: "r", status: AgentRunStatus.IN_PROGRESS }],
  });
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "sessionTitleUpdated",
        value: {
          sessionId: "s",
          title: "new title",
          updatedAtMs: 300n,
        },
      },
    }),
  );
  expect(state?.updatedAtMs).toBe(300n);
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "runCompleted",
        value: {
          sessionId: "s",
          run: { runId: "r", status: AgentRunStatus.COMPLETED, completedAtMs: 200n },
        },
      },
    }),
  );
  expect(state?.updatedAtMs).toBe(300n);
});

test("snapshot replaces display; direct events preserve order and terminal wins over deltas", () => {
  let state = applyAgentEvent(
    undefined,
    create(AgentEventSchema, {
      payload: {
        case: "subscriptionReady",
        value: {
          session: {
            sessionId: "s",
            runs: [
              {
                runId: "r",
                inputId: "i",
                status: AgentRunStatus.IN_PROGRESS,
                items: [
                  { itemId: "item", content: { case: "agentMessage", value: { text: "before" } } },
                ],
              },
            ],
          },
        },
      },
    }),
  );
  const old = state;
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "agentMessageDelta",
        value: {
          sessionId: "s",
          runId: "r",
          itemId: "item",
          delta: "after",
        },
      },
    }),
  );
  expect(chatMessages(state)[1].blocks).toMatchObject([{ kind: "text", text: "beforeafter" }]);
  expect(chatMessages(old)[1].blocks).toMatchObject([{ kind: "text", text: "before" }]);
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "runCompleted",
        value: {
          sessionId: "s",
          run: {
            runId: "r",
            inputId: "i",
            status: AgentRunStatus.COMPLETED,
            items: [
              { itemId: "item", content: { case: "agentMessage", value: { text: "final" } } },
            ],
          },
        },
      },
    }),
  );
  expect(chatMessages(state)[1]).toMatchObject({
    blocks: [{ kind: "text", text: "final" }],
    status: "complete",
  });
  const unrelated = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "sessionDeleted",
        value: {
          sessionId: "other",
        },
      },
    }),
  );
  expect(unrelated).toBe(state);
  const fresh = create(AgentSessionSchema, { sessionId: "s" });
  expect(
    applyAgentEvent(
      state,
      create(AgentEventSchema, {
        payload: {
          case: "subscriptionReady",
          value: { session: fresh },
        },
      }),
    ),
  ).toBe(fresh);
});

test("tool completion replaces pending state and survives snapshot restore", () => {
  const initial = create(AgentSessionSchema, {
    sessionId: "s",
    runs: [{ runId: "r", status: AgentRunStatus.IN_PROGRESS }],
  });
  const event = (status: AgentToolStatus, output: string) =>
    create(AgentEventSchema, {
      payload: {
        case: status === AgentToolStatus.PENDING ? "itemStarted" : "itemCompleted",
        value: {
          sessionId: "s",
          runId: "r",
          item: {
            itemId: "tool-block",
            content: {
              case: "toolCall",
              value: { name: "Read", status, output, argumentsJson: '{"path":"a.txt"}' },
            },
          },
        },
      },
    });
  let state = applyAgentEvent(initial, event(AgentToolStatus.PENDING, ""));
  expect(chatMessages(state)[1].blocks).toMatchObject([
    {
      id: "tool-block",
      kind: "tool",
      call: { name: "Read", status: AgentToolStatus.PENDING, argumentsJson: '{"path":"a.txt"}' },
    },
  ]);
  state = applyAgentEvent(state, event(AgentToolStatus.COMPLETED, "1: verified"));
  expect(state?.runs[0].items).toHaveLength(1);
  const restored = applyAgentEvent(
    undefined,
    create(AgentEventSchema, {
      payload: { case: "subscriptionReady", value: { session: state } },
    }),
  );
  expect(chatMessages(restored)[1].blocks).toMatchObject([
    {
      id: "tool-block",
      kind: "tool",
      call: { name: "Read", status: AgentToolStatus.COMPLETED, output: "1: verified" },
    },
  ]);
});

test("generation and final response identity survive reconnect", () => {
  let state: AgentSession | undefined = create(AgentSessionSchema, {
    sessionId: "s",
    runs: [
      {
        runId: "r",
        status: AgentRunStatus.IN_PROGRESS,
        generation: { genId: "first", startedAtMs: 100n },
        items: [
          {
            itemId: "intro",
            genId: "first",
            content: { case: "agentMessage", value: { text: "process commentary" } },
          },
        ],
      },
    ],
  });
  const update = (generation?: { genId: string; startedAtMs: bigint }) =>
    create(AgentEventSchema, {
      payload: { case: "generationUpdated", value: { sessionId: "s", runId: "r", generation } },
    });
  expect(chatMessages(state)[1].generation).toMatchObject({
    id: "first",
    startedAtMs: 100,
    receivedContent: false,
  });
  state = applyAgentEvent(state, update());
  expect(chatMessages(state)[1].generation).toBeUndefined();
  state = applyAgentEvent(state, update({ genId: "second", startedAtMs: 500n }));
  state = applyAgentEvent(
    undefined,
    create(AgentEventSchema, {
      payload: { case: "subscriptionReady", value: { session: state } },
    }),
  );
  expect(chatMessages(state)[1].generation).toMatchObject({
    id: "second",
    startedAtMs: 500,
    receivedContent: false,
  });

  const run = state?.runs[0];
  if (!run) throw new Error("Missing snapshot run");
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "runCompleted",
        value: {
          sessionId: "s",
          run: {
            ...run,
            status: AgentRunStatus.COMPLETED,
            finalGenId: "second",
            generation: undefined,
          },
        },
      },
    }),
  );
  expect(chatMessages(state)[1].generation).toBeUndefined();
  expect(chatMessages(state)[1].finalResponseBlockIds).toEqual([]);
  state?.runs[0].items.push({
    ...run.items[0],
    itemId: "answer",
    genId: "second",
  });
  expect(chatMessages(state)[1].finalResponseBlockIds).toEqual(["answer"]);
});

test("interleaved blocks retain order across live updates and reconnect", () => {
  let state: AgentSession | undefined = create(AgentSessionSchema, {
    sessionId: "s",
    runs: [
      {
        runId: "r",
        inputId: "i",
        status: AgentRunStatus.IN_PROGRESS,
        items: [
          { itemId: "thought", content: { case: "reasoning", value: { text: "先定位" } } },
          { itemId: "intro", content: { case: "agentMessage", value: { text: "我先找配置。" } } },
          {
            itemId: "glob",
            content: {
              case: "toolCall",
              value: {
                name: "Glob",
                status: AgentToolStatus.COMPLETED,
                output: "config.json",
              },
            },
          },
          {
            itemId: "middle",
            content: { case: "agentMessage", value: { text: "找到了，读取。" } },
          },
          {
            itemId: "read",
            content: {
              case: "toolCall",
              value: {
                name: "Read",
                status: AgentToolStatus.PENDING,
                argumentsJson: '{"path":"config.json"}',
              },
            },
          },
        ],
      },
    ],
  });
  const original = state;
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "itemCompleted",
        value: {
          sessionId: "s",
          runId: "r",
          item: {
            itemId: "read",
            content: {
              case: "toolCall",
              value: {
                name: "Read",
                status: AgentToolStatus.COMPLETED,
                output: "timeout: 30",
                argumentsJson: '{"path":"config.json"}',
                durationMs: 0n,
              },
            },
          },
        },
      },
    }),
  );
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "itemStarted",
        value: {
          sessionId: "s",
          runId: "r",
          item: {
            itemId: "answer",
            content: { case: "agentMessage", value: { text: "" } },
          },
        },
      },
    }),
  );
  state = applyAgentEvent(
    state,
    create(AgentEventSchema, {
      payload: {
        case: "agentMessageDelta",
        value: {
          sessionId: "s",
          runId: "r",
          itemId: "answer",
          delta: "超时 **30 秒**。",
        },
      },
    }),
  );

  const blocks = chatMessages(state)[1].blocks;
  expect(blocks?.map((block) => [block.id, block.kind])).toEqual([
    ["thought", "reasoning"],
    ["intro", "text"],
    ["glob", "tool"],
    ["middle", "text"],
    ["read", "tool"],
    ["answer", "text"],
  ]);
  expect(blocks?.[4]).toMatchObject({ call: { output: "timeout: 30", durationMs: 0n } });
  expect(blocks?.[5]).toMatchObject({ text: "超时 **30 秒**。" });
  expect(chatMessages(original)[1].blocks?.[4]).toMatchObject({
    call: { status: AgentToolStatus.PENDING, output: "" },
  });
  const reconnected = applyAgentEvent(
    undefined,
    create(AgentEventSchema, {
      payload: { case: "subscriptionReady", value: { session: state } },
    }),
  );
  expect(chatMessages(reconnected)[1].blocks).toEqual(blocks);
});

test("Run duration uses recorded start and end, preserving unknown and zero values", () => {
  const session = create(AgentSessionSchema, {
    sessionId: "s",
    runs: [
      {
        runId: "r",
        startedAtMs: 100n,
        status: AgentRunStatus.COMPLETED,
        items: [
          {
            itemId: "read",
            content: {
              case: "toolCall",
              value: { name: "Read", status: AgentToolStatus.COMPLETED, durationMs: 9000n },
            },
          },
        ],
      },
    ],
  });
  expect(chatMessages(session)[1].durationMs).toBeUndefined();
  expect(chatMessages(session).map((message) => message.timestampMs)).toEqual([100n, 100n]);
  session.runs[0].completedAtMs = 100n;
  expect(chatMessages(session)[1].durationMs).toBe(0n);
  session.runs[0].completedAtMs = 1350n;
  expect(chatMessages(session)[1].durationMs).toBe(1250n);
  session.runs[0].completedAtMs = 99n;
  expect(chatMessages(session)[1].durationMs).toBeUndefined();
});
