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
  expect(chatMessages(state)[1].text).toBe("beforeafter");
  expect(chatMessages(old)[1].text).toBe("before");
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
  expect(chatMessages(state)[1]).toMatchObject({ text: "final", status: "complete" });
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
  expect(chatMessages(state)[1].tools).toEqual([
    { id: "tool-block", name: "Read", status: "执行中", output: '{"path":"a.txt"}' },
  ]);
  state = applyAgentEvent(state, event(AgentToolStatus.COMPLETED, "1: verified"));
  expect(state?.runs[0].items).toHaveLength(1);
  const restored = applyAgentEvent(
    undefined,
    create(AgentEventSchema, {
      payload: { case: "subscriptionReady", value: { session: state } },
    }),
  );
  expect(chatMessages(restored)[1].tools).toEqual([
    { id: "tool-block", name: "Read", status: "已完成", output: "1: verified" },
  ]);
});
