import {
  Provider,
  ProviderBalance,
  Summary,
  SummaryRequest,
  FinishCause,
  ModelMessage,
  ModelIssue,
  ModelRequest,
  ModelResponse,
  ToolCall,
  Usage
} from "../../shared/contracts/provider";

// ─────────────────────────────────────────────────────────────────────────────
// 智谱 GLM Provider
//
// 智谱 API (https://open.bigmodel.cn/api/paas/v4/chat/completions) 与 OpenAI 兼容:
//   - 认证: Bearer <api-key>,key 格式为 <id>.<secret>
//   - 流式: SSE, data: {...}\n\n, 终止标记 data: [DONE]
//   - 工具调用: tool_calls[].function.arguments 为 JSON 字符串(增量拼接)
//   - 深度思考: reasoning_content 字段(需在请求中带 thinking 参数)
//   - finish_reason: stop | tool_calls | length | sensitive | content_filter
//
// 与 DeepSeek 的差异:
//   - base URL 不同(open.bigmodel.cn vs api.deepseek.com)
//   - thinking 模式通过请求体 thinking 参数控制(DeepSeek 自动启用)
//   - finish_reason 多一个 "sensitive"(内容审核)
//   - 余额查询 API 不同(/paas/v4/billing 不稳定,暂用模型自检)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

type ZhipuToolCall = {
  id: string;
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
};

type ZhipuMessage = {
  role: ModelMessage["role"];
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ZhipuToolCall[];
  reasoning_content?: string;
};

function toZhipuMessage(message: ModelMessage): ZhipuMessage {
  return {
    content: message.text,
    reasoning_content: message.continuationThinking,
    role: message.role,
    tool_call_id: message.toolCallKey,
    tool_calls: message.toolCalls?.map((call) => ({
      function: { arguments: call.argumentsText, name: call.name },
      id: call.callId,
      type: "function"
    }))
  };
}

function mapFinishCause(value?: string | null): FinishCause {
  if (value === "stop") return "complete";
  if (value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  if (value === "content_filter" || value === "sensitive") return "content_filter";
  if (value === "insufficient_system_resource") return "insufficient_system_resource";
  return "unknown";
}

function protocolIssueFor(input: {
  answer: string;
  finishCause: FinishCause;
  sawDone: boolean;
  toolCalls: ToolCall[];
}): ModelIssue | undefined {
  if (!input.sawDone) {
    return { code: "incomplete_stream", message: "智谱 SSE 流未收到 [DONE] 结束标记。", retryable: true };
  }
  if (/<[｜|]{0,2}tool_calls\b/i.test(input.answer)) {
    return { code: "text_tool_protocol", message: "模型把工具调用作为文本标记输出，而不是结构化 tool_calls。", retryable: true };
  }
  if (input.finishCause === "unknown") {
    return { code: "unknown_finish", message: "智谱返回了未知或缺失的 finish_reason。", retryable: true };
  }
  if (
    (input.finishCause === "tool_calls" && input.toolCalls.length === 0) ||
    (input.finishCause === "complete" && input.toolCalls.length > 0)
  ) {
    return { code: "finish_mismatch", message: "智谱的 finish_reason 与结构化工具调用不一致。", retryable: true };
  }
  if (input.finishCause === "complete" && !input.answer.trim()) {
    return { code: "empty_response", message: "智谱在未调用工具时返回了空回答。", retryable: true };
  }
  return undefined;
}

function mapUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): Usage | undefined {
  if (!raw) return undefined;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens
  };
}

export class ZhipuProvider implements Provider {
  readonly capabilities = {
    // GLM-4.5 系列上下文窗口为 128K(模型固有能力,不是用户配置)。
    contextWindowTokens: 128_000,
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = process.env.ZHIPU_API_URL ?? DEFAULT_API_URL,
    private readonly balanceRequestTimeoutMs = 10_000
  ) {}

  async summarizeContext(request: SummaryRequest): Promise<Summary> {
    const response = await this.stream({
      maxOutputTokens: 2_048,
      messages: [
        {
          role: "system",
          text: "你是上下文压缩器。只从给定对话中提取语义信息，不推断文件变更、命令状态、测试结果、审批或工具事实。只输出 JSON 对象，字段为 objective、constraints、decisions、unresolvedQuestions。数组最多 20 项，每项简短。"
        },
        { role: "user", text: request.transcript }
      ],
      model: request.model,
      signal: request.signal,
      tools: []
    });
    const match = response.answer.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("智谱语义压缩未返回 JSON。");
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const list = (value: unknown) => Array.isArray(value)
      ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20).map((item) => item.slice(0, 500))
      : [];
    return {
      constraints: list(raw.constraints),
      decisions: list(raw.decisions),
      objective: typeof raw.objective === "string" ? raw.objective.trim().slice(0, 1_200) : undefined,
      unresolvedQuestions: list(raw.unresolvedQuestions)
    };
  }

  async stream(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error("缺少智谱 API Key。请在配置中设置后重启 Runtime。");
    const body: Record<string, unknown> = {
      messages: request.messages.map(toZhipuMessage),
      model: request.model,
      stream: true,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {})
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        function: {
          description: tool.description,
          name: tool.name,
          parameters: tool.inputSchema
        },
        type: "function"
      }));
    }
    // GLM 普通请求保持显式启用；轻量摘要请求可单独关闭思考。
    body.thinking = { type: request.thinkingMode ?? "enabled" };

    const response = await fetch(this.apiUrl, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: request.signal
    });
    if (!response.ok) {
      throw new Error(`智谱 API 请求失败：${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("智谱响应没有可读取的流。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls: ToolCall[] = [];
    let buffer = "";
    let answer = "";
    let thinking = "";
    let finishCause: FinishCause = "unknown";
    let usage: Usage | undefined;
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, "");
        if (!data || line.trim() === data) continue;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{
                id?: string;
                index?: number;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) {
          thinking += delta.reasoning_content;
          request.onFragment?.({ kind: "thinking", text: delta.reasoning_content });
        }
        if (delta?.content) {
          answer += delta.content;
          request.onFragment?.({ kind: "answer", text: delta.content });
        }
        for (const rawCall of delta?.tool_calls ?? []) {
          const index = rawCall.index ?? calls.length;
          const call =
            calls[index] ??
            ({ argumentsText: "", callId: rawCall.id ?? `pending_${index}`, index, name: "" } satisfies ToolCall);
          if (rawCall.id) call.callId = rawCall.id;
          if (rawCall.function?.name) call.name = rawCall.function.name;
          if (rawCall.function?.arguments) call.argumentsText += rawCall.function.arguments;
          calls[index] = call;
          request.onFragment?.({
            argumentsText: rawCall.function?.arguments,
            callId: call.callId,
            index,
            kind: "tool_call",
            name: call.name || undefined
          });
        }
        if (choice?.finish_reason) finishCause = mapFinishCause(choice.finish_reason);
        const nextUsage = mapUsage(chunk.usage);
        if (nextUsage) {
          usage = nextUsage;
          request.onFragment?.({ kind: "usage", usage });
        }
      }
    }

    const toolCalls = calls.filter((call) => call.callId && call.name);
    const protocolIssue = protocolIssueFor({ answer, finishCause, sawDone, toolCalls });
    return {
      answer,
      continuationMessage: {
        continuationThinking: toolCalls.length > 0 ? thinking : undefined,
        role: "assistant",
        text: answer || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      },
      finishCause,
      protocolIssue,
      thinking,
      toolCalls,
      usage
    };
  }

  // 智谱余额查询:GET /paas/v4/billing
  // 该接口稳定性一般(不同套餐返回结构不同),失败静默,不影响主流程。
  async getBalance(): Promise<ProviderBalance> {
    if (!this.apiKey) throw new Error("缺少智谱 API Key，无法查询余额。");
    const balanceUrl = new URL("../billing", this.apiUrl).toString();
    const signal = AbortSignal.timeout(this.balanceRequestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(balanceUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        method: "GET",
        signal
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`智谱余额查询超时:超过 ${this.balanceRequestTimeoutMs}ms。`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`智谱余额查询失败:HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    // 兼容两种返回结构:数组形式(balanceInfos)或对象形式(data)
    const infos = data.balanceInfos as Array<{ balance: string; subject: string }> | undefined;
    if (Array.isArray(infos) && infos.length > 0) {
      return {
        balanceInfos: infos.map((item) => ({
          currency: "CNY",
          grantedBalance: 0,
          toppedUpBalance: 0,
          totalBalance: Number(item.balance) || 0
        })),
        isAvailable: true
      };
    }
    const d = (data.data ?? data) as { totalBalance?: string; grantedBalance?: string; toppedUpBalance?: string };
    return {
      balanceInfos: [{
        currency: "CNY",
        grantedBalance: Number(d.grantedBalance) || 0,
        toppedUpBalance: Number(d.toppedUpBalance) || 0,
        totalBalance: Number(d.totalBalance) || 0
      }],
      isAvailable: true
    };
  }
}
