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

type DeepSeekToolCall = {
  id: string;
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
};

type DeepSeekMessage = {
  role: ModelMessage["role"];
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
  reasoning_content?: string;
};

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";

// DeepSeek 账户余额查询结果复用 ProviderBalance 类型(shared/contracts/provider.ts)。
// getBalance 返回 ProviderBalance,与 Provider 接口定义一致。

function toDeepSeekMessage(message: ModelMessage): DeepSeekMessage {
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
  if (value === "content_filter") return "content_filter";
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
    return { code: "incomplete_stream", message: "DeepSeek SSE 流未收到 [DONE] 结束标记。", retryable: true };
  }
  if (/<[｜|]{0,2}DSML[｜|]{0,2}(?:tool_calls|invoke)|<\/?tool_calls\b/i.test(input.answer)) {
    return { code: "text_tool_protocol", message: "模型把工具调用作为 DSML/文本标记输出，而不是结构化 tool_calls。", retryable: true };
  }
  if (input.finishCause === "unknown") {
    return { code: "unknown_finish", message: "DeepSeek 返回了未知或缺失的 finish_reason。", retryable: true };
  }
  if (
    (input.finishCause === "tool_calls" && input.toolCalls.length === 0) ||
    (input.finishCause === "complete" && input.toolCalls.length > 0)
  ) {
    return { code: "finish_mismatch", message: "DeepSeek 的 finish_reason 与结构化工具调用不一致。", retryable: true };
  }
  if (input.finishCause === "complete" && !input.answer.trim()) {
    return { code: "empty_response", message: "DeepSeek 在未调用工具时返回了空回答。", retryable: true };
  }
  return undefined;
}

function mapUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}): Usage | undefined {
  if (!raw) return undefined;
  return {
    cacheHitTokens: raw.prompt_cache_hit_tokens,
    cacheMissTokens: raw.prompt_cache_miss_tokens,
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens
  };
}

export class DeepSeekProvider implements Provider {
  readonly capabilities = {
    contextWindowTokens: Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? 1_000_000),
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL,
    private readonly balanceRequestTimeoutMs = 10_000
  ) {}

  // 查询账户余额(GET https://api.deepseek.com/user/balance)。
  // 从 this.apiUrl(默认 chat/completions 端点)取 origin 拼出 balance endpoint,
  // 这样用户自定义了 DEEPSEEK_API_URL 时余额接口也会跟着走同一个 host。
  async getBalance(): Promise<ProviderBalance> {
    if (!this.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY,无法查询余额。");
    const balanceUrl = new URL("/user/balance", new URL(this.apiUrl).origin).toString();
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
        throw new Error(`DeepSeek 余额查询超时:超过 ${this.balanceRequestTimeoutMs}ms。`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败:HTTP ${response.status}`);
    const data = await response.json() as {
      is_available: boolean;
      balance_infos: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
    };
    return {
      isAvailable: data.is_available,
      balanceInfos: (data.balance_infos ?? []).map((item) => ({
        currency: item.currency,
        totalBalance: Number(item.total_balance),
        grantedBalance: Number(item.granted_balance),
        toppedUpBalance: Number(item.topped_up_balance)
      }))
    };
  }

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
    if (!match) throw new Error("DeepSeek 语义压缩未返回 JSON。");
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
    if (!this.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY。请在 .env.local 中配置后重启 Runtime。");
    const response = await fetch(this.apiUrl, {
      body: JSON.stringify({
        messages: request.messages.map(toDeepSeekMessage),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                function: {
                  description: tool.description,
                  name: tool.name,
                  parameters: tool.inputSchema
                },
                type: "function"
              }))
            }
          : {})
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: request.signal
    });
    if (!response.ok) {
      throw new Error(`DeepSeek API 请求失败：${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("DeepSeek 响应没有可读取的流。");

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
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
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
}
