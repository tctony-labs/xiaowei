import { create } from "@bufbuild/protobuf";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  AgentModelConfigSchema,
  AgentRunStatus,
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
} from "xiaowei-contracts";
import { createServices } from "../../services";
import { AgentChatClient, agentChatClient } from "./client";
import { agentIdentity } from "./identity";
import { agentFixture } from "./test-fixture";

const config = create(AgentModelConfigSchema, { modelRef: "test" });

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
    .createSession(create(CreateSessionRequestSchema, { clientRequestId: agentIdentity(), config }));
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
  const otherServices = createServices(() => fixture.host.client({ caller: "other", trusted: true }));
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
    expect(Math.abs(Number.parseInt(id.slice(0, 13).replace("-", ""), 16) - Date.now())).toBeLessThan(1000);
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
  await waitFor(() => expect(client.messages[1].text).toBe("finished while hidden"));
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
  expect(debug).toHaveBeenCalledWith(`Agent new conversation opened previous_session=${previousId}`);
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
  fixture.disconnectObservers();
  fixture.finish(AgentRunStatus.COMPLETED, "settled during reconnection");
  await waitFor(() => expect(fixture.counts.disconnected).toBe(1));
  await waitFor(() => expect(client.messages[1].text).toBe("settled during reconnection"));
  expect(client.error).toBe("");
  expect(fixture.requests).toHaveLength(1);
  fixture.disconnectObservers();
  await waitFor(() => expect(fixture.counts.disconnected).toBe(2));
  await waitFor(() => expect(client.error).toContain("请重试操作"));
  expect(fixture.counts.observing).toBe(0);
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
  expect(client.messages[1].text).toBe("answer");
  await client.listSessions();
  expect(client.sessions.map((session) => session.sessionId)).toContain(secondId);
  await client.switchSession(secondId);
  expect(client.draft).toBe("second draft");
  expect(client.messages[1].text).toBe("second finished offscreen");
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
