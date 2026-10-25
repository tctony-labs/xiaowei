import { clone, create } from "@bufbuild/protobuf";
import {
  type AcknowledgeInteractionRequest,
  AcknowledgeInteractionResponseSchema,
  Agent,
  type AgentEvent,
  AgentEventSchema,
  type AgentInteraction,
  AgentInteractionSchema,
  AgentInteractionStatus,
  AgentRunSchema,
  AgentRunStatus,
  type AgentSession,
  AgentSessionSchema,
  AgentSessionStatus,
  AgentSessionSummarySchema,
  CreateSessionResponseSchema,
  DeleteSessionResponseSchema,
  type InteractionDeliveryEvent,
  InteractionDeliveryEventSchema,
  InterruptRunResponseSchema,
  ListSessionsResponseSchema,
  ReadSessionResponseSchema,
  RegenerateTitleResponseSchema,
  type RespondInteractionRequest,
  RespondInteractionResponseSchema,
  SessionRetentionPolicySchema,
  SessionViewingReadySchema,
  SetSessionArchivedResponseSchema,
  SetSessionConfigResponseSchema,
  SetSessionTitleResponseSchema,
  type StartRunRequest,
  StartRunResponseSchema,
} from "xiaowei-contracts";
import { bindHandlers, bindStreamHandlers, GatewayFailure } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { agentIdentity } from "./identity";

export function agentFixture(host = new GatewayHost()) {
  let session: AgentSession | undefined;
  const sessions = new Map<string, AgentSession>();
  const creations = new Map<string, AgentSession>();
  let created = 0;
  let interrupted = 0;
  let deleted = 0;
  let disconnected = 0;
  let lostResponse = false;
  let failBeforeAcceptance = false;
  let failList = false;
  let failConfig = false;
  const disconnectors = new Set<() => void>();
  const requests: StartRunRequest[] = [];
  const titleRequests: string[] = [];
  const interactionRequests: RespondInteractionRequest[] = [];
  const receipts: AcknowledgeInteractionRequest[] = [];
  let failInteractionResponse = false;
  let failInteractionBeforeAcceptance = false;
  let auxiliaryAvailable = true;
  const setTitleRequests: { sessionId: string; title: string }[] = [];
  const observers = new Set<(event: AgentEvent) => void>();
  const interactionObservers = new Set<() => void>();
  function emit(event: AgentEvent) {
    for (const observer of observers) observer(clone(AgentEventSchema, event));
    for (const observer of interactionObservers) observer();
  }
  function finish(
    status = AgentRunStatus.COMPLETED,
    text = "answer",
    thinking = "reason",
    sessionId = session?.sessionId,
  ) {
    const session = sessions.get(sessionId ?? "");
    if (!session) throw new Error("No session");
    const run = session.runs.at(-1);
    if (!run) throw new Error("No run");
    run.status = status;
    const genId = run.generation?.genId ?? agentIdentity();
    run.finalGenId = status === AgentRunStatus.COMPLETED ? genId : undefined;
    run.generation = undefined;
    run.completedAtMs = BigInt(Date.now());
    session.updatedAtMs =
      run.completedAtMs > session.updatedAtMs ? run.completedAtMs : session.updatedAtMs;
    run.items = [
      run.items[0],
      ...run.items.filter((item) => item.content.case === "toolCall"),
      {
        $typeName: "xiaowei.agent.AgentItem",
        itemId: agentIdentity(),
        genId,
        content: {
          case: "reasoning",
          value: { $typeName: "xiaowei.agent.AgentReasoning", text: thinking },
        },
      },
      {
        $typeName: "xiaowei.agent.AgentItem",
        itemId: agentIdentity(),
        genId,
        content: { case: "agentMessage", value: { $typeName: "xiaowei.agent.AgentMessage", text } },
      },
    ];
    session.status = AgentSessionStatus.IDLE;
    emit(
      create(AgentEventSchema, {
        payload: { case: "runCompleted", value: { sessionId: session.sessionId, run } },
      }),
    );
  }
  const owner = host.registerOwner("agent-fixture", [
    ...bindHandlers(Agent, {
      acknowledgeInteraction(request) {
        receipts.push(request);
        return create(AcknowledgeInteractionResponseSchema);
      },
      respondInteraction(request) {
        interactionRequests.push(request);
        if (failInteractionBeforeAcceptance) {
          failInteractionBeforeAcceptance = false;
          throw new GatewayFailure({ code: "TIMEOUT", message: "Not accepted" });
        }
        const target = sessions.get(request.sessionId);
        const run = target?.runs.at(-1);
        const tool = run?.items
          .flatMap((item) => (item.content.case === "toolCall" ? [item.content.value] : []))
          .find((tool) => tool.interaction?.interactionId === request.interactionId);
        if (!target || !run || !tool?.interaction) throw new Error("Missing interaction");
        const view = tool.interaction;
        if (view.status !== AgentInteractionStatus.PENDING) {
          if (view.clientRequestId === request.clientRequestId) {
            return create(RespondInteractionResponseSchema, { interaction: view });
          }
          throw new GatewayFailure({ code: "CONFLICT", message: "Already answered" });
        }
        view.status = AgentInteractionStatus.RESOLVED;
        view.revision = 2n;
        view.answer = request.answer;
        view.clientRequestId = request.clientRequestId;
        emit(
          create(AgentEventSchema, {
            payload: {
              case: "interactionUpdated",
              value: {
                sessionId: target.sessionId,
                runId: run.runId,
                toolId: tool.toolId,
                interaction: view,
              },
            },
          }),
        );
        if (failInteractionResponse) {
          failInteractionResponse = false;
          throw new GatewayFailure({ code: "TIMEOUT", message: "Response lost" });
        }
        return create(RespondInteractionResponseSchema, { interaction: view });
      },
      getSessionRetentionPolicy() {
        return create(SessionRetentionPolicySchema, { archiveAfterDays: 3 });
      },
      setSessionRetentionPolicy(request) {
        return request.policy ?? create(SessionRetentionPolicySchema, { archiveAfterDays: 3 });
      },
      createSession(request) {
        created++;
        session =
          creations.get(request.clientRequestId) ??
          create(AgentSessionSchema, {
            sessionId: agentIdentity(),
            metadataRevision: 1n,
            createdAtMs: BigInt(Date.now()),
            config: request.config,
            titleModelRef: request.titleModelRef,
            autoTitleEnabled: true,
            archiveRevision: 1n,
            updatedAtMs: BigInt(Date.now()),
            status: AgentSessionStatus.IDLE,
          });
        sessions.set(session.sessionId, session);
        creations.set(request.clientRequestId, session);
        return create(CreateSessionResponseSchema, { session: clone(AgentSessionSchema, session) });
      },
      listSessions(request) {
        if (failList) {
          failList = false;
          throw new GatewayFailure({ code: "TIMEOUT", message: "disconnected" });
        }
        return create(ListSessionsResponseSchema, {
          sessions: [...sessions.values()]
            .filter((s) => s.archived === request.archived)
            .sort(
              (a, b) =>
                Number(b.updatedAtMs - a.updatedAtMs) || b.sessionId.localeCompare(a.sessionId),
            )
            .map((session) =>
              create(AgentSessionSummarySchema, {
                sessionId: session.sessionId,
                title: session.title,
                autoTitleEnabled: session.autoTitleEnabled,
                status: session.status,
                createdAtMs: session.createdAtMs,
                metadataRevision: session.metadataRevision,
                updatedAtMs: session.updatedAtMs,
                archived: session.archived,
                archiveRevision: session.archiveRevision,
              }),
            ),
        });
      },
      setSessionArchived(request) {
        const session = sessions.get(request.sessionId);
        if (!session) throw new Error("unknown session");
        if (session.archiveRevision !== request.expectedArchiveRevision)
          throw new Error("archive revision conflict");
        if (request.archived && session.status === AgentSessionStatus.RUNNING) {
          finish(AgentRunStatus.INTERRUPTED, "partial", "", request.sessionId);
        }
        session.archived = request.archived;
        session.archiveRevision++;
        emit(
          create(AgentEventSchema, {
            payload: {
              case: "sessionArchivedUpdated",
              value: {
                sessionId: request.sessionId,
                archived: session.archived,
                archiveRevision: session.archiveRevision,
              },
            },
          }),
        );
        return create(SetSessionArchivedResponseSchema, {
          archived: session.archived,
          archiveRevision: session.archiveRevision,
        });
      },
      readSession(request) {
        const session = sessions.get(request.sessionId);
        return create(ReadSessionResponseSchema, {
          found: !!session,
          session: session ? clone(AgentSessionSchema, session) : undefined,
        });
      },
      setSessionConfig(request) {
        if (failConfig) {
          failConfig = false;
          throw new GatewayFailure({ code: "HANDLER_ERROR", message: "disk failure" });
        }
        const session = sessions.get(request.sessionId);
        if (!session) throw new GatewayFailure({ code: "NOT_FOUND", message: "session missing" });
        if (session.metadataRevision !== request.expectedMetadataRevision) {
          throw new GatewayFailure({ code: "CONFLICT", message: "stale revision" });
        }
        session.config = request.config;
        session.metadataRevision++;
        emit(
          create(AgentEventSchema, {
            payload: {
              case: "sessionConfigUpdated",
              value: {
                sessionId: session.sessionId,
                config: session.config,
                metadataRevision: session.metadataRevision,
              },
            },
          }),
        );
        return create(SetSessionConfigResponseSchema, {
          metadataRevision: session.metadataRevision,
        });
      },
      setSessionTitle(request) {
        const session = sessions.get(request.sessionId);
        if (!session) throw new GatewayFailure({ code: "NOT_FOUND", message: "session missing" });
        const title = request.title.trim();
        if (!title || Array.from(title).length > 50 || /[\r\n]/.test(title)) {
          throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid title" });
        }
        setTitleRequests.push({ sessionId: request.sessionId, title });
        updateTitle(title, session.titleModelRef, request.sessionId, false);
        return create(SetSessionTitleResponseSchema, {
          title,
          metadataRevision: session.metadataRevision,
        });
      },
      regenerateTitle(request) {
        titleRequests.push(request.sessionId);
        if (!auxiliaryAvailable) {
          throw new GatewayFailure({
            code: "HANDLER_ERROR",
            message: "尚未配置小文本任务模型，请先在设置中选择",
          });
        }
        updateTitle("生成的标题", request.titleModelRef, request.sessionId);
        const session = sessions.get(request.sessionId);
        return create(RegenerateTitleResponseSchema, {
          title: session?.title,
          metadataRevision: session?.metadataRevision,
        });
      },
      deleteSession(request) {
        const results = request.targets.map((item) => {
          const target = sessions.get(item.sessionId);
          deleted++;
          if (target) {
            sessions.delete(target.sessionId);
            emit(
              create(AgentEventSchema, {
                payload: { case: "sessionDeleted", value: { sessionId: target.sessionId } },
              }),
            );
            if (session?.sessionId === target.sessionId) session = undefined;
          }
          return { sessionId: item.sessionId, status: 1 };
        });
        return create(DeleteSessionResponseSchema, { results });
      },
      startRun(request) {
        const session = sessions.get(request.sessionId);
        if (!session) throw new Error("No session");
        requests.push(request);
        if (failBeforeAcceptance)
          throw new GatewayFailure({ code: "TIMEOUT", message: "unknown acceptance" });
        if (!session.runs.length && !session.title) {
          const initial = request.input
            .flatMap((input) => (input.content.case === "text" ? [input.content.value] : []))
            .join(" ");
          updateTitle(Array.from(initial).slice(0, 15).join(""), "", request.sessionId, true);
        }
        const run = create(AgentRunSchema, {
          runId: agentIdentity(),
          inputId: request.inputId,
          status: AgentRunStatus.IN_PROGRESS,
          config: request.config ?? session.config,
          startedAtMs: BigInt(Date.now()),
          generation: { genId: agentIdentity(), startedAtMs: BigInt(Date.now()) },
          items: [
            {
              itemId: agentIdentity(),
              content: { case: "userMessage", value: { content: request.input } },
            },
          ],
        });
        session.runs.push(run);
        session.updatedAtMs = run.startedAtMs;
        session.config = run.config;
        session.titleModelRef = request.titleModelRef ?? session.titleModelRef;
        session.status = AgentSessionStatus.RUNNING;
        emit(
          create(AgentEventSchema, {
            payload: {
              case: "runStarted",
              value: {
                sessionId: session.sessionId,
                run: clone(AgentRunSchema, run),
                sessionMetadataRevision: session.metadataRevision,
                titleModelRef: session.titleModelRef,
              },
            },
          }),
        );
        if (lostResponse) throw new GatewayFailure({ code: "TIMEOUT", message: "lost response" });
        return create(StartRunResponseSchema, { run });
      },
      interruptRun() {
        interrupted++;
        return create(InterruptRunResponseSchema, { found: true, cancellationRequested: true });
      },
    }),
    ...bindStreamHandlers(Agent, {
      observeInteractions(request, client) {
        const signal = client.cancellation();
        const seen = new Set<string>();
        const queue: InteractionDeliveryEvent[] = [
          create(InteractionDeliveryEventSchema, {
            payload: {
              case: "ready",
              value: {
                instanceId: "fixture-instance",
                observerId: agentIdentity(),
              },
            },
          }),
        ];
        let wake: (() => void) | undefined;
        function scan() {
          const target = sessions.get(request.sessionId);
          for (const item of target?.runs.flatMap((run) => run.items) ?? []) {
            const view =
              item.content.case === "toolCall" ? item.content.value.interaction : undefined;
            if (
              !view ||
              seen.has(view.interactionId) ||
              view.status !== AgentInteractionStatus.PENDING
            )
              continue;
            seen.add(view.interactionId);
            queue.push(
              create(InteractionDeliveryEventSchema, {
                payload: {
                  case: "delivery",
                  value: { deliveryId: agentIdentity(), interaction: view },
                },
              }),
            );
          }
          wake?.();
        }
        scan();
        interactionObservers.add(scan);
        signal.addEventListener("abort", () => wake?.(), { once: true });
        return (async function* () {
          try {
            while (!signal.aborted) {
              const event = queue.shift();
              if (event) yield event;
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          } finally {
            interactionObservers.delete(scan);
          }
        })();
      },
      trackSessionViewing(_request, client) {
        const signal = client.cancellation();
        return (async function* () {
          yield create(SessionViewingReadySchema);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
      subscribeSession(request, client) {
        const signal = client.cancellation();
        const session = sessions.get(request.sessionId);
        if (!session || session.sessionId !== request.sessionId) {
          throw new GatewayFailure({ code: "NOT_FOUND", message: "session missing" });
        }
        const queue: AgentEvent[] = [
          create(AgentEventSchema, {
            payload: {
              case: "subscriptionReady",
              value: { session: clone(AgentSessionSchema, session) },
            },
          }),
        ];
        let wake: (() => void) | undefined;
        let ended = false;
        const disconnect = () => {
          ended = true;
          wake?.();
        };
        disconnectors.add(disconnect);
        const listener = (event: AgentEvent) => {
          if (
            !event.payload.value ||
            !("sessionId" in event.payload.value) ||
            event.payload.value.sessionId !== request.sessionId
          )
            return;
          queue.push(event);
          wake?.();
        };
        observers.add(listener);
        signal.addEventListener("abort", () => wake?.(), { once: true });
        return (async function* () {
          try {
            while (!signal.aborted && !ended) {
              if (queue.length) {
                const event = queue.shift();
                if (event) yield event;
              } else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          } finally {
            observers.delete(listener);
            disconnectors.delete(disconnect);
            disconnected++;
          }
        })();
      },
    }),
  ]);
  function updateTitle(
    title: string,
    modelRef = session?.titleModelRef ?? "",
    sessionId = session?.sessionId,
    autoTitleEnabled = true,
  ) {
    const session = sessions.get(sessionId ?? "");
    if (!session) throw new Error("No session");
    session.title = title;
    session.autoTitleEnabled = autoTitleEnabled;
    session.titleModelRef = modelRef;
    session.metadataRevision++;
    session.updatedAtMs = BigInt(Date.now());
    emit(
      create(AgentEventSchema, {
        payload: {
          case: "sessionTitleUpdated",
          value: {
            sessionId: session.sessionId,
            title,
            autoTitleEnabled,
            titleModelRef: modelRef,
            metadataRevision: session.metadataRevision,
            updatedAtMs: session.updatedAtMs,
          },
        },
      }),
    );
  }
  return {
    interactionRequests,
    receipts,
    openInteraction(request: AgentInteraction["request"]) {
      const run = session?.runs.at(-1);
      if (!session || !run) throw new Error("No active run");
      const genId = run.generation?.genId;
      run.generation = undefined;
      emit(
        create(AgentEventSchema, {
          payload: {
            case: "generationUpdated",
            value: {
              sessionId: session.sessionId,
              runId: run.runId,
            },
          },
        }),
      );
      const view = create(AgentInteractionSchema, {
        interactionId: agentIdentity(),
        revision: 1n,
        request,
        status: AgentInteractionStatus.PENDING,
      });
      const item = {
        $typeName: "xiaowei.agent.AgentItem" as const,
        itemId: agentIdentity(),
        genId,
        content: {
          case: "toolCall" as const,
          value: {
            $typeName: "xiaowei.agent.AgentToolCall" as const,
            toolId: agentIdentity(),
            turnId: agentIdentity(),
            genId: genId ?? "",
            providerCallId: agentIdentity(),
            name: request.case === "question" ? "AskUserQuestion" : "RequestPermission",
            argumentsJson: "{}",
            status: 1,
            output: "",
            interaction: view,
          },
        },
      };
      run.items.push(item);
      emit(
        create(AgentEventSchema, {
          payload: {
            case: "itemStarted",
            value: {
              sessionId: session.sessionId,
              runId: run.runId,
              item,
            },
          },
        }),
      );
      return view;
    },
    loseNextInteractionResponse() {
      failInteractionResponse = true;
    },
    failNextInteractionBeforeAcceptance() {
      failInteractionBeforeAcceptance = true;
    },
    host,
    requests,
    sessions,
    titleRequests,
    setAuxiliaryAvailable(available: boolean) {
      auxiliaryAvailable = available;
    },
    setTitleRequests,
    updateTitle,
    finish,
    owner,
    get session() {
      return session;
    },
    get counts() {
      return {
        created,
        interrupted,
        deleted,
        disconnected,
        observing: observers.size,
        interactionsObserving: interactionObservers.size,
      };
    },
    loseResponse() {
      lostResponse = true;
    },
    failBeforeAcceptance() {
      failBeforeAcceptance = true;
    },
    failNextList() {
      failList = true;
    },
    failNextConfig() {
      failConfig = true;
    },
    disconnectObservers() {
      for (const disconnect of disconnectors) disconnect();
    },
    emit,
  };
}
