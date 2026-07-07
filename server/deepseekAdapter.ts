import { AgentRun, VerificationRule } from "../shared/agentTypes";
import { eventTitleForTool, RunStore } from "./eventStore";
import { collectDiffSummary, executeRuntimeTool, runtimeToolSchemas } from "./tools";

type ChatMessage = {
  content?: string | null;
  reasoning_content?: string;
  role: "system" | "user" | "assistant" | "tool";
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  index?: number;
  type: "function";
};

type StreamResult = {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
};

type StreamCallbacks = {
  onContentDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
};

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

function getStableSystemPrompt(projectRoot: string): string {
  return [
    "你是 DeepSeeker CodeAgent，一个本地编程 agent。",
    "你需要用工具观察真实项目状态，不要凭空声称已完成。",
    "维护任务列表时调用 update_task；update_task 只代表你的意图层，runtime 会用真实证据维护验证层。",
    "需要查看文件时使用 list_files/read_file/git_status。需要验证时使用 run_command。",
    "当前工具只允许只读文件、Git 状态和白名单命令；不要尝试编辑文件。",
    `项目根目录：${projectRoot}`
  ].join("\n");
}

function getAgentState(run: AgentRun): string {
  const tasks =
    run.tasks.length > 0
      ? run.tasks
          .map(
            (task) =>
              `- ${task.id}: ${task.title} | agent=${task.agentStatus} | runtime=${task.runtimeStatus} | display=${task.displayStatus}`
          )
          .join("\n")
      : "- none";

  return [
    "<agent_state>",
    "tasks:",
    tasks,
    "workspace_diff:",
    `changed_files=${run.diffSummary.changedFiles} additions=${run.diffSummary.additions} deletions=${run.diffSummary.deletions}`,
    "latest_evidence:",
    ...(run.evidence.slice(-4).map((item) => `- ${item.title}: ${item.detail}`) || ["- none"]),
    "</agent_state>"
  ].join("\n");
}

function parseJSONArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseVerificationRule(value: unknown): VerificationRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "command_exit_zero" && typeof candidate.commandPattern === "string") {
    return {
      commandPattern: candidate.commandPattern,
      kind: "command_exit_zero"
    };
  }
  if (candidate.kind === "file_changed" && typeof candidate.pathPattern === "string") {
    return {
      kind: "file_changed",
      pathPattern: candidate.pathPattern
    };
  }
  return undefined;
}

function normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls
    .filter((call) => call.id && call.function.name)
    .map((call) => ({
      function: {
        arguments: call.function.arguments || "{}",
        name: call.function.name
      },
      id: call.id,
      type: "function"
    }));
}

function createBufferedEmitter(onEmit?: (chunk: string) => void): (chunk?: string, flush?: boolean) => void {
  let buffer = "";

  return (chunk = "", flush = false) => {
    buffer += chunk;
    if (!onEmit) {
      buffer = "";
      return;
    }
    if (!flush && buffer.length < 180 && !buffer.includes("\n")) return;
    const next = buffer.trim();
    buffer = "";
    if (next) onEmit(next);
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("运行已取消。", "AbortError");
  }
}

async function readDeepSeekStream(
  response: Response,
  callbacks: StreamCallbacks = {},
  signal?: AbortSignal
): Promise<StreamResult> {
  if (!response.body) {
    throw new Error("DeepSeek 响应没有可读取的流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const emitContent = createBufferedEmitter(callbacks.onContentDelta);
  const emitReasoning = createBufferedEmitter(callbacks.onReasoningDelta);
  const toolCalls: ToolCall[] = [];
  let content = "";
  let reasoningContent = "";
  let buffer = "";

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      const chunk = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              function?: {
                arguments?: string;
                name?: string;
              };
              id?: string;
              index?: number;
              type?: "function";
            }>;
          };
        }>;
      };

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        emitReasoning(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        emitContent(delta.content);
      }

      for (const deltaToolCall of delta.tool_calls ?? []) {
        const index = deltaToolCall.index ?? toolCalls.length;
        const existing =
          toolCalls[index] ??
          ({
            function: {
              arguments: "",
              name: ""
            },
            id: "",
            index,
            type: "function"
          } satisfies ToolCall);

        existing.id = deltaToolCall.id ?? existing.id;
        existing.type = "function";
        existing.function.name = deltaToolCall.function?.name ?? existing.function.name;
        existing.function.arguments += deltaToolCall.function?.arguments ?? "";
        toolCalls[index] = existing;
      }
    }
  }

  emitReasoning("", true);
  emitContent("", true);

  return {
    content,
    reasoningContent,
    toolCalls: normalizeToolCalls(toolCalls)
  };
}

async function callDeepSeek(input: {
  apiKey: string;
  callbacks?: StreamCallbacks;
  messages: ChatMessage[];
  model: string;
  signal?: AbortSignal;
}): Promise<StreamResult> {
  const response = await fetch(DEEPSEEK_API_URL, {
    body: JSON.stringify({
      messages: input.messages,
      model: input.model,
      stream: true,
      tools: runtimeToolSchemas
    }),
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    method: "POST",
    signal: input.signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API 请求失败：${response.status} ${errorText}`);
  }

  return readDeepSeekStream(response, input.callbacks, input.signal);
}

async function executeToolCall(input: {
  projectRoot: string;
  runId: string;
  signal?: AbortSignal;
  store: RunStore;
  toolCall: ToolCall;
}): Promise<ChatMessage> {
  const { projectRoot, runId, signal, store, toolCall } = input;
  throwIfAborted(signal);
  const args = parseJSONArguments(toolCall.function.arguments);
  const toolName = toolCall.function.name;
  const title = eventTitleForTool(toolName);

  store.addEvent(runId, {
    body: toolCall.function.arguments,
    meta: {
      tokenSource: "tool_calls",
      toolName
    },
    status: "completed",
    title: `${title}请求已生成`,
    type: "tool.call.created"
  });

  if (toolName === "update_task") {
    store.updateTask(runId, {
      agentStatus: args.agentStatus as AgentRun["tasks"][number]["agentStatus"],
      id: String(args.id ?? "task_unknown"),
      title: String(args.title ?? args.id ?? "未命名任务"),
      verification: parseVerificationRule(args.verification)
    });
    return {
      content: "任务状态已更新。",
      role: "tool",
      tool_call_id: toolCall.id
    };
  }

  store.updateHUD(runId, {
    currentStepTitle: title,
    status: "running_tool"
  });
  store.addEvent(runId, {
    body: toolName,
    meta: {
      tokenSource: "tool_calls",
      toolName
    },
    status: "running",
    title: `${title}中`,
    type: "tool.execution.started"
  });

  try {
    throwIfAborted(signal);
    const result = await executeRuntimeTool(projectRoot, toolName, args);
    throwIfAborted(signal);
    const executedCommand = toolName === "run_command" ? String(args.command ?? "") : undefined;
    const evidence = store.addEvidence(runId, {
      detail: executedCommand ? `${executedCommand}\n${result.slice(0, 500)}` : result.slice(0, 500),
      kind: toolName === "git_status" ? "git" : toolName === "run_command" ? "command" : "tool",
      status: "completed",
      title
    });

    store.addEvent(runId, {
      body: result.slice(0, 1200),
      meta: {
        tokenSource: "tool_calls",
        toolName
      },
      status: "completed",
      title: `${title}完成`,
      type: "tool.execution.completed"
    });

    const diffSummary = await collectDiffSummary(projectRoot);
    store.updateDiff(runId, diffSummary);

    if (evidence) {
      for (const task of store.getRun(runId)?.tasks ?? []) {
        const verification = task.verification;
        if (
          task.agentStatus === "claimed_done" &&
          verification?.kind === "command_exit_zero" &&
          executedCommand &&
          executedCommand.includes(verification.commandPattern)
        ) {
          store.updateTask(runId, {
            evidenceRef: evidence.id,
            id: task.id,
            runtimeStatus: "verified"
          });
        }
        if (
          task.agentStatus === "claimed_done" &&
          verification?.kind === "file_changed" &&
          diffSummary.files.some((file) => file.path.includes(verification.pathPattern))
        ) {
          store.updateTask(runId, {
            evidenceRef: evidence.id,
            id: task.id,
            runtimeStatus: "verified"
          });
        }
      }
    }

    return {
      content: result,
      role: "tool",
      tool_call_id: toolCall.id
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.addEvent(runId, {
      body: message,
      meta: {
        tokenSource: "tool_calls",
        toolName
      },
      status: "failed",
      title: `${title}失败`,
      type: "tool.execution.failed"
    });
    return {
      content: message,
      role: "tool",
      tool_call_id: toolCall.id
    };
  }
}

export async function runDeepSeekAgent(input: {
  apiKey: string;
  model: string;
  projectRoot: string;
  prompt: string;
  runId: string;
  signal?: AbortSignal;
  store: RunStore;
}): Promise<void> {
  const { apiKey, model, projectRoot, prompt, runId, signal, store } = input;

  if (!apiKey) {
    store.failRun(runId, "缺少 DEEPSEEK_API_KEY。请在 .env.local 中配置后重启 runtime。");
    return;
  }

  const messages: ChatMessage[] = [
    {
      content: getStableSystemPrompt(projectRoot),
      role: "system"
    },
    {
      content: getAgentState(store.getRun(runId)!),
      role: "system"
    },
    {
      content: prompt,
      role: "user"
    }
  ];

  let finalContent = "";

  for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
    throwIfAborted(signal);
    const turnId = `${runId}_turn_${turnIndex + 1}`;
    store.updateHUD(runId, {
      currentStepTitle: "DeepSeek 正在思考",
      status: "thinking"
    });
    store.addEvent(runId, {
      status: "running",
      title: "DeepSeek 流式响应已开始",
      type: "model.stream.started"
    });

    const result = await callDeepSeek({
      apiKey,
      callbacks: {
        onContentDelta: (chunk) => {
          store.addEvent(runId, {
            body: chunk.slice(0, 1600),
            meta: {
              tokenSource: "content"
            },
            status: "running",
            title: "模型正在生成回复",
            turnId,
            type: "model.content.delta"
          });
        },
        onReasoningDelta: (chunk) => {
          store.addEvent(runId, {
            body: chunk.slice(0, 1200),
            meta: {
              tokenSource: "reasoning_content"
            },
            status: "running",
            title: "模型正在思考",
            turnId,
            type: "model.reasoning.delta"
          });
        }
      },
      messages,
      model,
      signal
    });

    if (result.content.trim()) {
      finalContent = result.content.trim();
    }

    const assistantMessage: ChatMessage = {
      content: result.content || null,
      reasoning_content: result.reasoningContent || undefined,
      role: "assistant",
      tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined
    };
    messages.push(assistantMessage);

    if (result.toolCalls.length === 0) {
      store.completeRun(runId, finalContent || "已完成。");
      return;
    }

    for (const toolCall of result.toolCalls) {
      const toolResult = await executeToolCall({
        projectRoot,
        runId,
        signal,
        store,
        toolCall
      });
      messages.push(toolResult);
    }

    messages.splice(1, 1, {
      content: getAgentState(store.getRun(runId)!),
      role: "system"
    });
  }

  store.completeRun(runId, finalContent || "已达到本阶段最大工具循环次数。");
}
