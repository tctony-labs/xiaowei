import { create } from "@bufbuild/protobuf";
import {
  type AgentModelConfig,
  type AgentSession,
  type AgentSessionSummary,
  AgentSessionSummarySchema,
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  DeleteSessionStatus,
  InterruptRunRequestSchema,
  ListSessionsRequestSchema,
  ReadSessionRequestSchema,
  RegenerateTitleRequestSchema,
  SetSessionArchivedRequestSchema,
  SetSessionConfigRequestSchema,
  SetSessionTitleRequestSchema,
  StartRunRequestSchema,
  SubscribeSessionRequestSchema,
} from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";
import type { Services } from "../../services";
import { applyAgentEvent, chatMessages } from "./agent-events";
import { agentIdentity } from "./identity";

type Observer = () => void;
const clients = new WeakMap<Services, AgentChatClient>();
export function agentChatClient(services: Services) {
  let client = clients.get(services);
  if (!client) {
    client = new AgentChatClient(services);
    clients.set(services, client);
  }
  return client;
}

export class AgentChatClient {
  session?: AgentSession;
  error = "";
  private creationId = agentIdentity();
  private listeners = new Set<Observer>();
  private generation = 0;
  private stream?: Awaited<ReturnType<ReturnType<Services["getAgentStream"]>["subscribeSession"]>>;
  private connecting?: Promise<void>;
  private sending?: Promise<void>;
  private changing?: Promise<void>;
  private listing?: Promise<void>;
  private drafts = new Map<string, string>();
  private feedback = new Map<string, { pending?: { inputId: string; text: string }; error: string }>();
  sessions: AgentSessionSummary[] = [];
  sessionsLoading = false;
  sessionsContinuation = "";
  private pending?: { inputId: string; text: string };
  private acceptedRun?: { sessionId: string; runId: string };
  private terminalWaiters = new Set<Observer>();
  private titleGeneration = 0;
  regeneratingTitle = false;
  configuring = false;
  initializing = false;
  private initialized = false;
  private initialization?: Promise<void>;

  constructor(private services: Services) {}

  restoreLatestSession(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.initialized || this.session || this.sending || this.changing) {
      this.initialized = true;
      return Promise.resolve();
    }

    this.initializing = true;
    const work = this.changeConversation(async () => {
      await this.listSessions();
      const latest = this.sessions[0];
      if (!latest) return;
      await this.connect(true, latest.sessionId);
      if (!this.listeners.size) this.disconnect();
      console.debug(`Agent latest session restored session=${latest.sessionId}`);
    });
    this.initialization = work.finally(() => {
      this.initialized = true;
      this.initializing = false;
      this.initialization = undefined;
      this.notify();
    });
    return this.initialization;
  }

  get messages() {
    const messages = chatMessages(this.session);
    if (this.pending && !this.session?.runs.some((run) => run.inputId === this.pending?.inputId)) {
      messages.push({ id: this.pending.inputId, role: "user", text: this.pending.text });
      messages.push({ id: `pending-${this.pending.inputId}`, role: "assistant", text: "", status: "generating" });
    }
    return messages;
  }

  get busy() {
    return (
      !!this.pending || !!this.sending || !!this.changing || this.session?.runs.some((run) => run.status === 1) === true
    );
  }

  get draft() {
    return this.drafts.get(this.session?.sessionId ?? "") ?? "";
  }

  setDraft(text: string, sessionId = this.session?.sessionId ?? "") {
    this.drafts.set(sessionId, text);
    this.notify();
  }

  draftFor(sessionId: string) {
    return this.drafts.get(sessionId) ?? "";
  }

  sessionTitle(session: AgentSessionSummary) {
    return session.title || "新的对话";
  }

  private forgetSession(sessionId: string) {
    this.sessions = this.sessions.filter((session) => session.sessionId !== sessionId);
    this.feedback.delete(sessionId);
    this.drafts.delete(sessionId);
  }

  observe(listener: Observer) {
    this.listeners.add(listener);
    listener();
    if (this.session && !this.stream) void this.connect().catch(() => {});
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.disconnect();
    };
  }

  private notify() {
    if (
      this.acceptedRun &&
      this.session?.sessionId === this.acceptedRun.sessionId &&
      this.session.runs.some((run) => run.runId === this.acceptedRun?.runId && run.status !== 1)
    ) {
      this.acceptedRun = undefined;
    }
    if (this.pending && this.session?.runs.some((run) => run.inputId === this.pending?.inputId)) {
      this.pending = undefined;
    }
    if (this.session) {
      const sessionId = this.session.sessionId;
      this.feedback.set(sessionId, { pending: this.pending, error: this.error });
      const summary = create(AgentSessionSummarySchema, {
        sessionId,
        title: this.session.title,
        autoTitleEnabled: this.session.autoTitleEnabled,
        status: this.session.status,
        createdAtMs: this.session.createdAtMs,
        metadataRevision: this.session.metadataRevision,
        updatedAtMs: this.session.updatedAtMs,
        archived: this.session.archived,
        archiveRevision: this.session.archiveRevision,
      });
      const index = this.sessions.findIndex((session) => session.sessionId === sessionId);
      if (summary.archived) {
        if (index >= 0) this.sessions.splice(index, 1);
      } else {
        if (index < 0) this.sessions.unshift(summary);
        else this.sessions[index] = summary;
        this.sessions.sort((a, b) =>
          a.updatedAtMs === b.updatedAtMs
            ? b.sessionId.localeCompare(a.sessionId)
            : a.updatedAtMs > b.updatedAtMs
              ? -1
              : 1,
        );
      }
    }
    for (const listener of this.listeners) listener();
    for (const waiter of this.terminalWaiters) waiter();
  }

  private disconnect() {
    this.generation++;
    const stream = this.stream;
    this.stream = undefined;
    this.connecting = undefined;
    void stream?.cancel().catch(() => {});
  }

  private connect(recover = true, sessionId = this.session?.sessionId): Promise<void> {
    if (this.stream) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!sessionId) return Promise.reject(new Error("No session"));
    const generation = ++this.generation;
    const opening = (async () => {
      const stream = await this.services
        .getAgentStream()
        .subscribeSession(create(SubscribeSessionRequestSchema, { sessionId }));
      if (generation !== this.generation) {
        await stream.cancel();
        throw new Error("Observation replaced");
      }
      this.stream = stream;
      const first = await stream.next();
      if (generation !== this.generation) throw new Error("Observation replaced");
      if (first.done || first.value.payload.case !== "subscriptionReady" || !first.value.payload.value.session) {
        throw new Error("Missing initial session snapshot");
      }
      if (this.session?.sessionId !== sessionId) {
        this.pending = this.feedback.get(sessionId)?.pending;
        this.error = this.feedback.get(sessionId)?.error ?? "";
      }
      this.session = first.value.payload.value.session;
      if (!this.pending || this.session.runs.some((run) => run.inputId === this.pending?.inputId)) this.error = "";
      this.notify();
      void (async () => {
        try {
          for await (const event of stream) {
            if (generation !== this.generation) return;
            const previousId = this.session?.sessionId;
            this.session = applyAgentEvent(this.session, event);
            if (!this.session) {
              if (previousId) this.forgetSession(previousId);
              this.pending = undefined;
              this.creationId = agentIdentity();
              this.disconnect();
              this.notify();
              return;
            }
            this.notify();
          }
          if (generation === this.generation && this.session) throw new Error("Observation ended");
        } catch {
          if (generation === this.generation) {
            this.stream = undefined;
            this.error = "会话连接已断开，正在同步状态。";
            this.notify();
            await stream.cancel().catch(() => {});
            if (generation !== this.generation) return;
            if (recover && this.listeners.size && this.session) {
              void this.connect(false).catch(() => {});
            } else {
              this.error = "会话连接已断开，请重试操作或新建对话。";
              this.notify();
            }
          }
        } finally {
          await stream.cancel().catch(() => {});
        }
      })();
    })();
    this.connecting = opening;
    return opening
      .catch((error) => {
        if (generation === this.generation) {
          this.disconnect();
          if (error instanceof GatewayFailure && error.detail.code === "NOT_FOUND") {
            this.forgetSession(sessionId);
            if (this.session?.sessionId === sessionId) {
              this.session = undefined;
              this.pending = undefined;
              this.creationId = agentIdentity();
            }
          }
          this.error = "同步会话失败，请重试操作或新建对话。";
          this.notify();
        }
        throw error;
      })
      .finally(() => {
        if (this.connecting === opening) this.connecting = undefined;
      });
  }

  async send(text: string, config: AgentModelConfig) {
    if (this.busy || this.configuring) throw new Error("Conversation busy");
    const inputId = agentIdentity();
    this.pending = { inputId, text };
    this.error = "";
    let sentSessionId = "";
    let accepted = false;
    let uncertain = false;
    const work = (async () => {
      if (!this.session) {
        const created = await this.services
          .getAgent()
          .createSession(create(CreateSessionRequestSchema, { clientRequestId: this.creationId, config }));
        if (!created.session) throw new Error("Missing created session");
        this.session = created.session;
        this.drafts.set(created.session.sessionId, this.drafts.get("") ?? "");
        this.drafts.delete("");
      }
      await this.connect();
      const sessionId = this.session?.sessionId;
      if (!sessionId) throw new Error("Session unavailable");
      sentSessionId = sessionId;
      try {
        uncertain = true;
        const response = await this.services.getAgent().startRun(
          create(StartRunRequestSchema, {
            sessionId,
            inputId,
            input: [{ content: { case: "text", value: text } }],
          }),
        );
        if (!response.run) throw new Error("Missing accepted run");
        accepted = true;
        this.acceptedRun = { sessionId, runId: response.run.runId };
        // Responses acknowledge commands, never replace the live projection.
      } catch (error) {
        if (
          error instanceof GatewayFailure &&
          ["INVALID_ARGUMENT", "CONFLICT", "RESOURCE_EXHAUSTED", "NOT_FOUND", "HANDLER_ERROR"].includes(
            error.detail.code,
          )
        ) {
          uncertain = false;
          throw error;
        }
        const current = await this.services
          .getAgent()
          .readSession(create(ReadSessionRequestSchema, { sessionId, includeRuns: true }));
        if (!current.session?.runs.some((run) => run.inputId === inputId)) {
          throw new Error("发送结果尚未确认，已保留原输入；请等待同步或新建对话，不会自动重发。");
        }
        accepted = true;
        // Query proves acceptance only. Re-observe atomically for current state.
        this.disconnect();
        await this.connect();
      }
    })();
    this.sending = work;
    this.notify();
    try {
      await work;
      return sentSessionId;
    } catch (error) {
      this.error =
        error instanceof Error && error.message.startsWith("发送结果")
          ? error.message
          : error instanceof GatewayFailure && error.detail.message.startsWith("会话记录")
            ? error.detail.message
            : "发送失败，请检查模型配置或会话连接。";
      throw error;
    } finally {
      if (!accepted && !uncertain) this.pending = undefined;
      this.sending = undefined;
      if (!this.listeners.size) this.disconnect();
      this.notify();
    }
  }

  async setConfig(config: AgentModelConfig) {
    if (!this.session || this.configuring || this.changing) return;
    const sessionId = this.session.sessionId;
    this.configuring = true;
    this.error = "";
    this.notify();
    try {
      await this.connect();
      const response = await this.services.getAgent().setSessionConfig(
        create(SetSessionConfigRequestSchema, {
          sessionId,
          config,
          expectedMetadataRevision: this.session.metadataRevision,
        }),
      );
      // Do not enable sending until the committed selection reaches the live projection.
      if (this.session?.sessionId === sessionId && this.session.metadataRevision < response.metadataRevision) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.terminalWaiters.delete(check);
            reject(new Error("Configuration observation timed out"));
          }, 5_000);
          const check = () => {
            if (this.session?.sessionId !== sessionId || this.session.metadataRevision >= response.metadataRevision) {
              clearTimeout(timer);
              this.terminalWaiters.delete(check);
              resolve();
            }
          };
          this.terminalWaiters.add(check);
          check();
        });
      }
    } catch (error) {
      if (this.session?.sessionId === sessionId) {
        this.error = "保存会话模型设置失败，请重试。";
        this.disconnect();
        await this.connect().catch(() => {});
        this.error = "保存会话模型设置失败，请重试。";
      }
      throw error;
    } finally {
      this.configuring = false;
      if (!this.listeners.size) this.disconnect();
      this.notify();
    }
  }

  async setTitle(title: string) {
    const sessionId = this.session?.sessionId;
    try {
      if (!sessionId) throw new Error("没有可设置标题的会话");
      if (this.changing) throw new Error("会话操作进行中，请稍后重试。");
      this.error = "";
      await this.connect();
      await this.services.getAgent().setSessionTitle(create(SetSessionTitleRequestSchema, { sessionId, title }));
      // The command acknowledgement must not replace newer title events.
    } catch (error) {
      const message =
        error instanceof GatewayFailure && error.detail.code === "INVALID_ARGUMENT"
          ? "标题需为单行文本，长度为 1～50 个字符。"
          : "设置标题失败，请重试。";
      if (this.session?.sessionId === sessionId) {
        this.error = message;
        this.notify();
      }
      throw new Error(message);
    } finally {
      if (!this.listeners.size) this.disconnect();
    }
  }

  async regenerateTitle() {
    if (this.busy || this.regeneratingTitle) throw new Error("请等待当前任务结束后重试");
    if (!this.session) throw new Error("没有可用于生成标题的会话");
    const sessionId = this.session.sessionId;
    const generation = ++this.titleGeneration;
    this.regeneratingTitle = true;
    this.notify();
    try {
      await this.connect();
      await this.services.getAgent().regenerateTitle(create(RegenerateTitleRequestSchema, { sessionId }));
      // Like run responses, this acknowledgement must not replace newer events.
    } catch (error) {
      if (error instanceof GatewayFailure && error.detail.message.includes("尚未配置小文本任务模型")) {
        throw new Error("尚未配置小文本任务模型，请先在设置中选择");
      }
      throw new Error("标题生成失败，请检查小文本任务模型配置后重试");
    } finally {
      if (this.titleGeneration === generation) this.regeneratingTitle = false;
      this.notify();
    }
  }

  async stop() {
    try {
      await this.sending?.catch(() => {});
      if (this.session && !this.stream) await this.connect();
      const run = this.session?.runs.find((run) => run.status === 1);
      const runId =
        run?.runId ?? (this.acceptedRun?.sessionId === this.session?.sessionId ? this.acceptedRun?.runId : undefined);
      if (!runId || !this.session) return;
      await this.services.getAgent().interruptRun(
        create(InterruptRunRequestSchema, {
          sessionId: this.session.sessionId,
          runId,
        }),
      );
    } catch (error) {
      this.error = "停止请求未确认，请同步会话后重试。";
      this.notify();
      throw error;
    }
  }

  listSessions(more = false): Promise<void> {
    if (this.listing) return this.listing;
    if (!more) {
      this.sessions = [];
      this.sessionsContinuation = "";
    }
    this.sessionsLoading = true;
    const work = (async () => {
      const response = await this.services.getAgent().listSessions(
        create(ListSessionsRequestSchema, {
          archived: false,
          continuation: more ? this.sessionsContinuation : "",
        }),
      );
      this.sessions = more
        ? [
            ...this.sessions,
            ...response.sessions.filter((next) => !this.sessions.some((s) => s.sessionId === next.sessionId)),
          ]
        : response.sessions;
      this.sessionsContinuation = response.continuation;
      if (this.error === "加载会话列表失败，请重试。") this.error = "";
    })();
    this.listing = work;
    this.notify();
    return work
      .catch((error) => {
        this.error = "加载会话列表失败，请重试。";
        throw error;
      })
      .finally(() => {
        this.listing = undefined;
        this.sessionsLoading = false;
        this.notify();
      });
  }

  archiveSession(sessionId: string, archived: boolean): Promise<void> {
    return this.changeConversation(async () => {
      await this.sending?.catch(() => {});
      const session =
        this.session?.sessionId === sessionId
          ? this.session
          : this.sessions.find((session) => session.sessionId === sessionId);
      if (!session) throw new Error("会话不在当前列表，请刷新后重试。");
      await this.services.getAgent().setSessionArchived(
        create(SetSessionArchivedRequestSchema, {
          sessionId,
          archived,
          expectedArchiveRevision: session.archiveRevision,
        }),
      );
      this.sessions = this.sessions.filter((session) => session.sessionId !== sessionId);
      if (archived && this.session?.sessionId === sessionId) this.openDraft();
      await this.listSessions();
    });
  }

  private changeConversation(work: () => Promise<void>): Promise<void> {
    if (this.changing) {
      this.error = "会话操作进行中，请稍后重试。";
      this.notify();
      return Promise.reject(new Error(this.error));
    }
    // Defer work until the transition is registered, so send cannot race it.
    const changing = Promise.resolve().then(work);
    this.changing = changing;
    this.notify();
    return changing
      .catch((error) => {
        this.error = error instanceof Error ? error.message : "会话操作失败，请重试。";
        throw error;
      })
      .finally(() => {
        this.changing = undefined;
        this.notify();
      });
  }

  private async settleCurrentRun() {
    await this.sending?.catch(() => {});
    if (!this.session) return;
    await this.connect();
    await this.stop();
    if (this.acceptedRun || this.session?.runs.some((run) => run.status === 1)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.terminalWaiters.delete(check);
          reject(new Error("停止尚未确认，请稍后重试。"));
        }, 10_000);
        const check = () => {
          if (!this.acceptedRun && !this.session?.runs.some((run) => run.status === 1)) {
            clearTimeout(timer);
            this.terminalWaiters.delete(check);
            resolve();
          }
        };
        this.terminalWaiters.add(check);
        check();
      });
    }
  }

  private openDraft() {
    this.disconnect();
    this.session = undefined;
    this.pending = undefined;
    this.acceptedRun = undefined;
    this.creationId = agentIdentity();
    this.error = "";
    this.titleGeneration++;
    this.regeneratingTitle = false;
    this.drafts.delete("");
  }

  newConversation(): Promise<void> {
    if (!this.busy && !this.session?.runs.length) return Promise.resolve();
    return this.changeConversation(async () => {
      await this.settleCurrentRun();
      const sessionId = this.session?.sessionId;
      if (!sessionId) return;
      this.openDraft();
      console.debug(`Agent new conversation opened previous_session=${sessionId}`);
    });
  }

  deleteConversation(): Promise<void> {
    return this.changeConversation(async () => {
      await this.settleCurrentRun();
      if (this.session) {
        const sessionId = this.session.sessionId;
        const deletion = await this.services.getAgent().deleteSession(
          create(DeleteSessionRequestSchema, {
            targets: [
              {
                sessionId,
                expectedMetadataRevision: this.session.metadataRevision,
              },
            ],
          }),
        );
        const result = deletion.results[0];
        if (result?.status !== DeleteSessionStatus.DELETED) {
          throw new Error(result?.error || "删除未完成，请刷新后重试。");
        }
        this.forgetSession(sessionId);
      }
      this.openDraft();
    });
  }

  switchSession(sessionId: string): Promise<void> {
    if (this.session?.sessionId === sessionId && this.stream) return Promise.resolve();
    return this.changeConversation(async () => {
      await this.sending?.catch(() => {});
      const response = await this.services.getAgent().readSession(create(ReadSessionRequestSchema, { sessionId }));
      if (!response.found || !response.session) {
        this.forgetSession(sessionId);
        throw new Error("会话已不存在，请重新选择。");
      }
      this.disconnect();
      this.titleGeneration++;
      this.regeneratingTitle = false;
      // Only the atomic stream snapshot supplies display history; ReadSession
      // locates the target and never merges history into a live observation.
      await this.connect(true, sessionId);
      if (!this.listeners.size) this.disconnect();
      console.debug(`Agent session switched session=${sessionId}`);
    });
  }
}
