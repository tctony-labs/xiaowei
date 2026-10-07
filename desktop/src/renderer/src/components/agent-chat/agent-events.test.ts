import { create } from "@bufbuild/protobuf";
import { expect, test } from "vitest";
import { AgentEventSchema, AgentRunStatus, type AgentSession, AgentSessionSchema } from "xiaowei-contracts";
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
                items: [{ itemId: "item", content: { case: "agentMessage", value: { text: "before" } } }],
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
            items: [{ itemId: "item", content: { case: "agentMessage", value: { text: "final" } } }],
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
