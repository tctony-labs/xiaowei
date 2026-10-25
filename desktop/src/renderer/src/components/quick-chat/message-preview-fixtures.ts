import { create } from "@bufbuild/protobuf";
import {
  AgentGenerationSchema,
  type AgentItem,
  AgentItemSchema,
  AgentRunStatus,
  AgentSessionSchema,
  AgentToolStatus,
} from "xiaowei-contracts";
import type { AgentGenerationState } from "../agent-chat/message-blocks";

export interface MessagePreviewOptions {
  scenario?:
    | "waiting"
    | "paused"
    | "plain-answer"
    | "single-tool"
    | "consecutive-tools"
    | "tools-with-response"
    | "empty-final-answer"
    | "tool-error-recovered"
    | "failed"
    | "stopped"
    | "markdown"
    | "long-content";
  pausedContent?: "reasoning" | "response" | "tool-call";
  singleTool?: "Read" | "Edit" | "Bash";
  waitingAfterTool?: boolean;
  toolSequence?: "same-tool" | "same-arguments" | "different-tools" | "across-generates";
  toolPhase?: "executing" | "waiting-next-response" | "answering" | "completed";
  emptyAfter?: "no-content" | "reasoning" | "tool";
  failureAt?: "before-output" | "reasoning" | "response" | "after-tools" | "unknown-tool";
  stopAt?: "response" | "tool";
  streamMarkdown?: boolean;
}

export const previewMarkdown = [
  "## 配置检查结果",
  "",
  "超时时间为 **30 秒**，配置位于 `config.json`。",
  "",
  "```json",
  '{ "timeout": 30, "endpoint": "https://example.com/api" }',
  "```",
  "",
  "| 字段 | 当前值 |",
  "| --- | --- |",
  "| timeout | 30 秒 |",
  "| retries | 3 次 |",
  "",
  "- [x] 确认当前配置",
  "- [ ] 根据接口耗时调整超时",
  "",
  "> 修改配置后，需要重新启动服务。",
  "",
  "更多内容见 [配置说明](https://example.com/docs/config)。",
].join("\n");

function response(id: string, text: string): AgentItem {
  return create(AgentItemSchema, {
    itemId: id,
    content: { case: "agentMessage", value: { text } },
  });
}

function reasoning(id: string, text: string): AgentItem {
  return create(AgentItemSchema, {
    itemId: id,
    content: { case: "reasoning", value: { text } },
  });
}

function tool(
  id: string,
  name: string,
  argumentsJson: string,
  output: string,
  status = AgentToolStatus.COMPLETED,
  genId = "gen-1",
): AgentItem {
  return create(AgentItemSchema, {
    itemId: id,
    content: {
      case: "toolCall",
      value: {
        toolId: id,
        providerCallId: id,
        turnId: genId,
        genId,
        name,
        argumentsJson,
        output,
        status,
      },
    },
  });
}

function read(id = "read", path = "/workspace/config.json", genId = "gen-1") {
  return tool(
    id,
    "Read",
    JSON.stringify({ path }),
    '1: { "timeout": 30, "retries": 3 }',
    AgentToolStatus.COMPLETED,
    genId,
  );
}

function glob() {
  return tool(
    "glob",
    "Glob",
    '{"path":"/workspace","pattern":"config.json"}',
    "/workspace/config.json",
  );
}

function processItems() {
  return [
    reasoning("reasoning", "先定位配置，再读取其中的超时字段。"),
    response("intro", "我先找一下配置文件。"),
    glob(),
    response("middle", "找到了，我读取一下。"),
    read("read", "/workspace/config.json", "gen-2"),
  ];
}

// Run/Item snapshots use the real display projection. Generate state and the final
// response boundary are explicit fixtures until the harness exposes them to the UI.
export function messagePreview(
  options: MessagePreviewOptions,
  startedAtMs: number,
  visibleMarkdown = previewMarkdown,
) {
  const {
    scenario = "tools-with-response",
    pausedContent = "reasoning",
    singleTool = "Read",
    waitingAfterTool = false,
    toolSequence = "same-tool",
    toolPhase = "completed",
    emptyAfter = "tool",
    failureAt = "after-tools",
    stopAt = "tool",
  } = options;
  const session = create(AgentSessionSchema, {
    sessionId: "message-preview",
    title: "检查服务配置",
    runs: [
      {
        runId: "run-preview",
        inputId: "input-preview",
        status: AgentRunStatus.COMPLETED,
        startedAtMs: BigInt(startedAtMs),
        items: [
          {
            itemId: "user",
            content: {
              case: "userMessage",
              value: {
                content: [
                  {
                    content: {
                      case: "text",
                      value: "帮我找到配置文件，检查超时时间。",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  const run = session.runs[0];
  let generation: AgentGenerationState | undefined;
  let finalResponseBlockIds: string[] | undefined;
  let items: AgentItem[] = [];

  function generate(receivedContent: boolean, activeBlockId?: string, id = "gen-1") {
    run.status = AgentRunStatus.IN_PROGRESS;
    generation = { id, startedAtMs, receivedContent, activeBlockId };
  }

  if (scenario === "waiting") {
    if (waitingAfterTool) items = [response("intro", "我先读取一下配置。"), read()];
    generate(false, undefined, waitingAfterTool ? "gen-2" : "gen-1");
  } else if (scenario === "paused") {
    if (pausedContent === "reasoning") {
      items = [reasoning("reasoning", "先查找配置文件。\n\n正在核对超时与重试次数。")];
      generate(true, "reasoning");
    } else if (pausedContent === "response") {
      items = [response("response", "已找到配置文件，超时时间为 **30 秒**。")];
      generate(true, "response");
    } else {
      // The model returned a tool declaration, but the Generate has not finished.
      generate(true);
    }
  } else if (scenario === "plain-answer") {
    items = [response("answer", "超时时间是 **30 秒**，失败后最多重试 **3 次**。")];
    finalResponseBlockIds = ["answer"];
  } else if (
    scenario === "single-tool" ||
    scenario === "consecutive-tools" ||
    scenario === "tools-with-response"
  ) {
    if (scenario === "single-tool") {
      let call = read();
      if (singleTool === "Edit") {
        call = tool(
          "edit",
          "Edit",
          '{"path":"/workspace/config.json","old_string":"20","new_string":"30"}',
          "已更新 /workspace/config.json",
        );
        if (call.content.case === "toolCall") {
          call.content.value.metadataJson = JSON.stringify({
            filediff: {
              additions: 1,
              deletions: 1,
              unified: '@@ -1 +1 @@\n-{"timeout":20}\n+{"timeout":30}\n',
            },
          });
        }
      } else if (singleTool === "Bash") {
        call = tool(
          "bash",
          "Bash",
          '{"command":"cat config.json"}',
          '{"timeout":30,"retries":3}\nProcess exited with code 0',
        );
      }
      items = [response("intro", "我先检查一下配置。"), call];
    } else if (scenario === "tools-with-response") {
      items = processItems();
    } else {
      items = [response("intro", "我先检查配置文件。")];
      if (toolSequence === "different-tools") {
        items.push(glob(), tool("grep", "Grep", '{"pattern":"timeout"}', "config.json:1"));
      } else {
        const secondPath =
          toolSequence === "same-arguments" ? "/workspace/config.json" : "/workspace/retries.json";
        const secondGen = toolSequence === "across-generates" ? "gen-2" : "gen-1";
        items.push(read("read-first"), read("read-second", secondPath, secondGen));
      }
    }

    if (toolPhase === "executing") {
      run.status = AgentRunStatus.IN_PROGRESS;
      const last = items.at(-1);
      if (last?.content.case === "toolCall") {
        last.content.value.status = AgentToolStatus.PENDING;
        last.content.value.output = "";
      }
    } else if (toolPhase === "waiting-next-response") {
      generate(false, undefined, "gen-next");
    } else {
      items.push(response("answer", "超时时间是 **30 秒**，失败后最多重试 **3 次**。"));
      if (toolPhase === "answering") generate(true, "answer", "gen-next");
      else finalResponseBlockIds = ["answer"];
    }
  } else if (scenario === "empty-final-answer") {
    if (emptyAfter === "tool") {
      items = [response("intro", "我先读取一下配置。"), read()];
    } else if (emptyAfter === "reasoning") {
      items = [reasoning("reasoning", "正在核对配置文件。")];
    }
    finalResponseBlockIds = [];
  } else if (scenario === "tool-error-recovered") {
    const failedRead = read();
    if (failedRead.content.case === "toolCall") {
      failedRead.content.value.status = AgentToolStatus.FAILED;
      failedRead.content.value.output = "文件读取失败";
    }
    items = [
      response("intro", "我先读取一下配置。"),
      failedRead,
      response("answer", "文件读取失败，请先检查文件访问权限。"),
    ];
    finalResponseBlockIds = ["answer"];
  } else if (scenario === "failed") {
    run.status = AgentRunStatus.FAILED;
    run.error = "模型连接中断，请检查连接后重新发送。";
    if (failureAt === "reasoning") {
      items = [reasoning("reasoning", "先定位配置文件，接着核对")];
    } else if (failureAt === "response") {
      items = [response("partial", "已找到配置文件，超时时间为")];
    } else if (failureAt === "after-tools") {
      items = processItems();
      run.error = "后续模型调用失败，执行记录已保留。";
    } else if (failureAt === "unknown-tool") {
      items = [
        response("intro", "我先检查一下项目配置。"),
        tool(
          "bash",
          "Bash",
          '{"command":"pnpm check"}',
          "无法确认命令结果，请先检查外部状态",
          AgentToolStatus.RESULT_UNKNOWN,
        ),
      ];
      run.error = "工具执行结果未知，运行已终止。";
    }
  } else if (scenario === "stopped") {
    run.status = AgentRunStatus.INTERRUPTED;
    if (stopAt === "response") {
      items = [response("partial", "已找到配置文件，超时时间为")];
    } else {
      items = [
        response("intro", "我先检查一下项目配置。"),
        read(),
        tool(
          "bash",
          "Bash",
          '{"command":"pnpm check"}',
          "用户已停止执行",
          AgentToolStatus.CANCELLED,
        ),
        tool(
          "grep",
          "Grep",
          '{"pattern":"timeout"}',
          "当前运行已停止，此工具未执行",
          AgentToolStatus.SKIPPED,
        ),
      ];
    }
  } else {
    const content =
      scenario === "long-content"
        ? [
            "## 长内容与窄窗口",
            "",
            `配置路径：/workspace/${"非常长的目录名称/".repeat(12)}config.json`,
            "",
            "```text",
            `endpoint=https://example.com/${"very-long-path/".repeat(24)}`,
            "```",
            "",
            "| 配置 | 路径 | 说明 |",
            "| --- | --- | --- |",
            `| endpoint | ${"service/".repeat(20)} | 保留完整内容，可横向滚动 |`,
            "",
            "较长的中文内容应在窗口内自然换行。".repeat(20),
          ].join("\n")
        : visibleMarkdown;
    items = [response("answer", content)];
    if (options.streamMarkdown && visibleMarkdown.length < previewMarkdown.length) {
      generate(visibleMarkdown.length > 0, visibleMarkdown ? "answer" : undefined);
    } else {
      finalResponseBlockIds = ["answer"];
    }
  }

  run.items.push(...items);
  for (const item of items) {
    item.genId = finalResponseBlockIds?.includes(item.itemId)
      ? "gen-final"
      : item.itemId === generation?.activeBlockId
        ? generation.id
        : item.content.case === "toolCall"
          ? item.content.value.genId
          : "gen-1";
  }
  if (generation) {
    run.generation = create(AgentGenerationSchema, {
      genId: generation.id,
      startedAtMs: BigInt(generation.startedAtMs),
      receivedContent: generation.receivedContent,
      activeItemId: generation.activeBlockId,
    });
  }
  if (finalResponseBlockIds !== undefined) run.finalGenId = "gen-final";
  if (run.status !== AgentRunStatus.IN_PROGRESS) run.completedAtMs = run.startedAtMs + 3200n;
  return { session, generation, finalResponseBlockIds };
}
