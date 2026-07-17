import {
  ProviderAdapter,
  ProviderFinishCause,
  ProviderMessage,
  ProviderProtocolIssue,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderUsage
} from "./providerTypes";

type DeepSeekToolCall = {
  id: string;
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
};

type DeepSeekMessage = {
  role: ProviderMessage["role"];
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
  reasoning_content?: string;
};

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";

function toDeepSeekMessage(message: ProviderMessage): DeepSeekMessage {
  return {
    content: message.text,
    reasoning_content: message.continuationThinking,
    role: message.role,
    tool_call_id: message.toolCallKey,
    tool_calls: message.toolCalls?.map((call) => ({
      function: { arguments: call.argumentsText, name: call.name },
      id: call.callKey,
      type: "function"
    }))
  };
}

function mapFinishCause(value?: string | null): ProviderFinishCause {
  if (value === "stop") return "complete";
  if (value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "insufficient_system_resource") return "insufficient_system_resource";
  return "unknown";
}

function protocolIssueFor(input: {
  answer: string;
  finishCause: ProviderFinishCause;
  sawDone: boolean;
  toolCalls: ProviderToolCall[];
}): ProviderProtocolIssue | undefined {
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
}): ProviderUsage | undefined {
  if (!raw) return undefined;
  return {
    cacheHitTokens: raw.prompt_cache_hit_tokens,
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens
  };
}

export class DeepSeekProvider implements ProviderAdapter {
  readonly capabilities = {
    contextWindowTokens: Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? 1_000_000),
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL
  ) {}

  async stream(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY。请在 .env.local 中配置后重启 Runtime。");
    const response = await fetch(this.apiUrl, {
      body: JSON.stringify({
        messages: request.messages.map(toDeepSeekMessage),
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
    const calls: ProviderToolCall[] = [];
    let buffer = "";
    let answer = "";
    let thinking = "";
    let finishCause: ProviderFinishCause = "unknown";
    let usage: ProviderUsage | undefined;
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
            ({ argumentsText: "", callKey: rawCall.id ?? `pending_${index}`, index, name: "" } satisfies ProviderToolCall);
          if (rawCall.id) call.callKey = rawCall.id;
          if (rawCall.function?.name) call.name = rawCall.function.name;
          if (rawCall.function?.arguments) call.argumentsText += rawCall.function.arguments;
          calls[index] = call;
          request.onFragment?.({
            argumentsText: rawCall.function?.arguments,
            callKey: call.callKey,
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

    const toolCalls = calls.filter((call) => call.callKey && call.name);
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
