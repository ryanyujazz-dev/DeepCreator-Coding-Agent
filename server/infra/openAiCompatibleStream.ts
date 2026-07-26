import {
  FinishCause,
  ModelIssue,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolSpec,
  Usage
} from "../../shared/contracts/provider";

type CompatibleChunk = {
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
  usage?: Record<string, number | undefined>;
};

export type CompatibleStreamDialect = {
  finishCause: (value?: string | null) => FinishCause;
  providerLabel: string;
  textToolPattern: RegExp;
  usage: (raw?: Record<string, number | undefined>) => Usage | undefined;
};

export function toCompatibleMessage(message: ModelMessage): Record<string, unknown> {
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

export function toCompatibleTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema
    },
    type: "function"
  }));
}

function protocolIssueFor(input: {
  answer: string;
  dialect: CompatibleStreamDialect;
  finishCause: FinishCause;
  sawDone: boolean;
  toolCalls: ToolCall[];
}): ModelIssue | undefined {
  const label = input.dialect.providerLabel;
  if (!input.sawDone) {
    return { code: "incomplete_stream", message: `${label} SSE 流未收到 [DONE] 结束标记。`, retryable: true };
  }
  if (input.dialect.textToolPattern.test(input.answer)) {
    return { code: "text_tool_protocol", message: "模型把工具调用作为文本标记输出，而不是结构化 tool_calls。", retryable: true };
  }
  if (input.finishCause === "unknown") {
    return { code: "unknown_finish", message: `${label} 返回了未知或缺失的 finish_reason。`, retryable: true };
  }
  if (
    (input.finishCause === "tool_calls" && input.toolCalls.length === 0)
    || (input.finishCause === "complete" && input.toolCalls.length > 0)
  ) {
    return { code: "finish_mismatch", message: `${label} 的 finish_reason 与结构化工具调用不一致。`, retryable: true };
  }
  if (input.finishCause === "complete" && !input.answer.trim()) {
    return { code: "empty_response", message: `${label} 在未调用工具时返回了空回答。`, retryable: true };
  }
  return undefined;
}

export async function decodeCompatibleStream(input: {
  body: ReadableStream<Uint8Array>;
  dialect: CompatibleStreamDialect;
  onFragment: ModelRequest["onFragment"];
}): Promise<ModelResponse> {
  const reader = input.body.getReader();
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
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      const chunk = JSON.parse(data) as CompatibleChunk;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) {
        thinking += delta.reasoning_content;
        input.onFragment?.({ kind: "thinking", text: delta.reasoning_content });
      }
      if (delta?.content) {
        answer += delta.content;
        input.onFragment?.({ kind: "answer", text: delta.content });
      }
      for (const rawCall of delta?.tool_calls ?? []) {
        const index = rawCall.index ?? calls.length;
        const call = calls[index]
          ?? ({ argumentsText: "", callId: rawCall.id ?? `pending_${index}`, index, name: "" } satisfies ToolCall);
        if (rawCall.id) call.callId = rawCall.id;
        if (rawCall.function?.name) call.name = rawCall.function.name;
        if (rawCall.function?.arguments) call.argumentsText += rawCall.function.arguments;
        calls[index] = call;
        input.onFragment?.({
          argumentsText: rawCall.function?.arguments,
          callId: call.callId,
          index,
          kind: "tool_call",
          name: call.name || undefined
        });
      }
      if (choice?.finish_reason) finishCause = input.dialect.finishCause(choice.finish_reason);
      const nextUsage = input.dialect.usage(chunk.usage);
      if (nextUsage) {
        usage = nextUsage;
        input.onFragment?.({ kind: "usage", usage });
      }
    }
  }

  const toolCalls = calls.filter((call) => call.callId && call.name);
  return {
    answer,
    continuationMessage: {
      continuationThinking: toolCalls.length > 0 ? thinking : undefined,
      role: "assistant",
      text: answer || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    finishCause,
    protocolIssue: protocolIssueFor({ answer, dialect: input.dialect, finishCause, sawDone, toolCalls }),
    thinking,
    toolCalls,
    usage
  };
}
