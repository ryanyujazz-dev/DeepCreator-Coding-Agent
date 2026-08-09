import {
  ModelCitation,
  ModelMessage,
  ModelOutputItem,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolSpec,
  Usage
} from "../../shared/contracts/provider";

type RawEvent = Record<string, unknown> & { type?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function responseUsage(value: unknown): Usage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const inputDetails = record(raw.input_tokens_details);
  return {
    cacheHitTokens: number(inputDetails?.cached_tokens),
    inputTokens: number(raw.input_tokens),
    outputTokens: number(raw.output_tokens)
  };
}

function citation(value: unknown): ModelCitation | undefined {
  const raw = record(value);
  const url = text(raw?.url);
  if (!raw || raw.type !== "url_citation" || !url) return undefined;
  return {
    endIndex: number(raw.end_index) ?? -1,
    startIndex: number(raw.start_index) ?? -1,
    title: text(raw.title) ?? url,
    url
  };
}

function outputText(item: Record<string, unknown>): { citations: ModelCitation[]; text: string } {
  const parts = Array.isArray(item.content) ? item.content : [];
  let result = "";
  const citations: ModelCitation[] = [];
  for (const part of parts) {
    const value = record(part);
    if (value?.type !== "output_text") continue;
    result += text(value.text) ?? "";
    if (Array.isArray(value.annotations)) {
      citations.push(...value.annotations.flatMap((annotation) => citation(annotation) ?? []));
    }
  }
  return { citations, text: result };
}

function itemType(type: unknown): ModelOutputItem["type"] | undefined {
  if (type === "reasoning") return "reasoning";
  if (type === "message") return "message";
  if (type === "function_call") return "function";
  if (type === "custom_tool_call") return "custom";
  if (type === "web_search_call") return "hosted_tool";
  return undefined;
}

function itemStatus(value: unknown, fallback: ModelOutputItem["status"]): ModelOutputItem["status"] {
  if (value === "completed") return "completed";
  if (value === "failed" || value === "incomplete") return "failed";
  if (value === "in_progress" || value === "searching") return "running";
  return fallback;
}

function searchDetails(item: Record<string, unknown>): Pick<ModelOutputItem, "searchQuery" | "searchStatus"> {
  const action = record(item.action);
  const queries = Array.isArray(action?.queries) ? action.queries.map(String).filter(Boolean) : [];
  return {
    searchQuery: text(action?.query) ?? (queries.join(" · ") || undefined),
    searchStatus: item.status === "completed"
      ? "completed"
      : item.status === "searching" ? "searching" : "in_progress"
  };
}

function mergeRawItem(
  current: Omit<ModelOutputItem, "modelStepId"> | undefined,
  raw: Record<string, unknown>,
  outputIndex: number,
  sequence: number,
  fallbackStatus: ModelOutputItem["status"]
): Omit<ModelOutputItem, "modelStepId"> | undefined {
  const type = itemType(raw.type) ?? current?.type;
  const itemId = text(raw.id) ?? current?.itemId;
  if (!type || !itemId) return undefined;
  const callId = text(raw.call_id) ?? current?.callId;
  const message = type === "message" ? outputText(raw) : undefined;
  const search = type === "hosted_tool" ? searchDetails(raw) : undefined;
  return {
    ...current,
    ...search,
    argumentsText: text(raw.arguments) ?? current?.argumentsText,
    callId,
    citations: message?.citations.length ? message.citations : current?.citations,
    draft: text(raw.input) ?? current?.draft,
    itemId,
    outputIndex,
    sequence,
    status: itemStatus(raw.status, fallbackStatus),
    text: message?.text || current?.text,
    toolName: text(raw.name) ?? (type === "hosted_tool" ? "web_search" : current?.toolName),
    type
  };
}

function responseInput(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const customCalls = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) if (call.name === "apply_patch") customCalls.add(call.callId);
  }
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const callId = message.toolCallKey;
      if (!callId) continue;
      input.push(customCalls.has(callId)
        ? { type: "custom_tool_call_output", call_id: callId, output: message.text ?? "" }
        : { type: "function_call_output", call_id: callId, output: message.text ?? "" });
      continue;
    }
    if (message.role === "assistant" && message.outputItems?.length) {
      for (const item of [...message.outputItems].sort((left, right) => left.outputIndex - right.outputIndex)) {
        if (item.type === "reasoning") {
          input.push({
            type: "reasoning",
            id: item.itemId,
            content: item.text ? [{ type: "reasoning_text", text: item.text }] : [],
            summary: []
          });
        } else if (item.type === "message") {
          input.push({
            type: "message",
            id: item.itemId,
            role: "assistant",
            status: item.status === "failed" ? "incomplete" : "completed",
            content: [{
              type: "output_text",
              text: item.text ?? "",
              annotations: (item.citations ?? []).map((source) => ({
                type: "url_citation",
                start_index: source.startIndex,
                end_index: source.endIndex,
                title: source.title,
                url: source.url
              }))
            }]
          });
        } else if (item.type === "function" && item.callId && item.toolName) {
          input.push({ type: "function_call", id: item.itemId, call_id: item.callId, name: item.toolName, arguments: item.argumentsText ?? "{}" });
        } else if (item.type === "custom" && item.callId && item.toolName) {
          input.push({ type: "custom_tool_call", id: item.itemId, call_id: item.callId, name: item.toolName, input: item.draft ?? "" });
        } else if (item.type === "hosted_tool") {
          input.push({
            type: "web_search_call",
            id: item.itemId,
            status: item.status === "failed" ? "failed" : "completed",
            action: item.searchQuery ? { type: "search", query: item.searchQuery } : undefined
          });
        }
      }
      continue;
    }
    if (message.text) input.push({ role: message.role, content: message.text });
    if (message.role !== "assistant") continue;
    if (message.continuationThinking) {
      input.push({
        type: "reasoning",
        content: [{ type: "reasoning_text", text: message.continuationThinking }],
        summary: []
      });
    }
    for (const call of message.toolCalls ?? []) {
      input.push(call.name === "apply_patch"
        ? { type: "custom_tool_call", call_id: call.callId, name: call.name, input: parsePatchInput(call.argumentsText) }
        : { type: "function_call", call_id: call.callId, name: call.name, arguments: call.argumentsText });
    }
  }
  return input;
}

function parsePatchInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as { patch?: unknown };
    return typeof parsed.patch === "string" ? parsed.patch : argumentsText;
  } catch {
    return argumentsText;
  }
}

export function toResponsesTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (tool.name === "web_search") {
      if (!output.some((item) => item.type === "web_search")) output.push({ type: "web_search" });
      continue;
    }
    if (tool.name === "apply_patch") {
      output.push({ type: "custom", name: "apply_patch", description: tool.description });
      continue;
    }
    output.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    });
  }
  return output;
}

export function toResponsesBody(request: ModelRequest): Record<string, unknown> {
  return {
    input: responseInput(request.messages),
    max_output_tokens: request.maxOutputTokens,
    model: request.model,
    parallel_tool_calls: true,
    stream: true,
    tools: toResponsesTools(request.tools)
  };
}

function sseMessages(buffer: string): { messages: RawEvent[]; rest: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  const messages = chunks.flatMap((chunk): RawEvent[] => {
    let eventType = "";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return [];
    const parsed = JSON.parse(data.join("\n")) as RawEvent;
    if (!parsed.type && eventType) parsed.type = eventType;
    return [parsed];
  });
  return { messages, rest };
}

export async function decodeResponsesStream(input: {
  body: ReadableStream<Uint8Array>;
  modelStepId: string;
  onFragment: ModelRequest["onFragment"];
}): Promise<ModelResponse> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  const items = new Map<string, Omit<ModelOutputItem, "modelStepId">>();
  let buffer = "";
  let answer = "";
  let thinking = "";
  let usage: Usage | undefined;
  let terminal: "completed" | "incomplete" | "failed" | undefined;
  let terminalError = "";

  const publish = (item: Omit<ModelOutputItem, "modelStepId">) => {
    items.set(item.itemId, item);
    input.onFragment?.({ item: structuredClone(item), kind: "output_item" });
  };
  const update = (event: RawEvent, mutate: (item: Omit<ModelOutputItem, "modelStepId">) => Omit<ModelOutputItem, "modelStepId">) => {
    const itemId = text(event.item_id);
    if (!itemId) return undefined;
    const current = items.get(itemId);
    if (!current) return undefined;
    const next = mutate({ ...current, sequence: number(event.sequence_number) ?? current.sequence });
    publish(next);
    return next;
  };
  const handle = (event: RawEvent) => {
    const type = text(event.type) ?? "";
    const sequence = number(event.sequence_number) ?? 0;
    const outputIndex = number(event.output_index) ?? 0;
    if (type === "response.output_item.added") {
      const raw = record(event.item);
      const item = raw ? mergeRawItem(undefined, raw, outputIndex, sequence, "generating") : undefined;
      if (item) publish(item);
      return;
    }
    if (type === "response.reasoning_text.delta") {
      const delta = text(event.delta) ?? "";
      thinking += delta;
      input.onFragment?.({ itemId: text(event.item_id), kind: "thinking", outputIndex, text: delta });
      update(event, (item) => ({ ...item, status: "generating", text: (item.text ?? "") + delta }));
      return;
    }
    if (type === "response.output_text.delta") {
      const delta = text(event.delta) ?? "";
      answer += delta;
      input.onFragment?.({ itemId: text(event.item_id), kind: "answer", outputIndex, text: delta });
      update(event, (item) => ({ ...item, status: "generating", text: (item.text ?? "") + delta }));
      return;
    }
    if (type === "response.output_text.annotation.added") {
      const nextCitation = citation(event.annotation);
      if (nextCitation) update(event, (item) => ({ ...item, citations: [...(item.citations ?? []), nextCitation] }));
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = text(event.delta) ?? "";
      update(event, (item) => ({ ...item, argumentsText: (item.argumentsText ?? "") + delta, status: "generating" }));
      return;
    }
    if (type === "response.custom_tool_call_input.delta") {
      const delta = text(event.delta) ?? "";
      update(event, (item) => ({ ...item, draft: (item.draft ?? "") + delta, status: "generating" }));
      return;
    }
    if (type.startsWith("response.web_search_call.")) {
      const status = type.endsWith(".completed") ? "completed" : type.endsWith(".searching") ? "searching" : "in_progress";
      update(event, (item) => ({
        ...item,
        searchStatus: status,
        status: status === "completed" ? "completed" : "running"
      }));
      return;
    }
    if (type === "response.output_item.done") {
      const raw = record(event.item);
      const currentId = text(raw?.id) ?? text(event.item_id);
      const current = currentId ? items.get(currentId) : undefined;
      const item = raw
        ? mergeRawItem(current, raw, outputIndex, sequence, "completed")
        : current ? { ...current, sequence, status: "completed" as const } : undefined;
      if (!item) return;
      publish(item);
      if (item.type === "function" && item.callId && item.toolName) {
        input.onFragment?.({ argumentsText: item.argumentsText, callId: item.callId, index: item.outputIndex, kind: "tool_call", name: item.toolName });
      }
      if (item.type === "custom" && item.callId && item.toolName === "apply_patch") {
        input.onFragment?.({
          argumentsText: JSON.stringify({ patch: item.draft ?? "" }),
          callId: item.callId,
          index: item.outputIndex,
          kind: "tool_call",
          name: item.toolName
        });
      }
      return;
    }
    if (type === "response.completed") {
      terminal = "completed";
      usage = responseUsage(record(event.response)?.usage);
      if (usage) input.onFragment?.({ kind: "usage", usage });
      return;
    }
    if (type === "response.incomplete" || type === "response.failed") {
      terminal = type === "response.failed" ? "failed" : "incomplete";
      const response = record(event.response);
      const error = record(response?.error);
      const incomplete = record(response?.incomplete_details);
      terminalError = text(error?.message) ?? text(incomplete?.reason) ?? `DeepSeek Responses ${terminal}`;
      for (const item of items.values()) {
        if (item.status === "generating" || item.status === "running") {
          publish({ ...item, error: terminalError, sequence, status: "failed" });
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const decoded = sseMessages(buffer);
    buffer = decoded.rest;
    decoded.messages.forEach(handle);
  }
  if (buffer.trim()) sseMessages(`${buffer}\n\n`).messages.forEach(handle);

  const outputItems: ModelOutputItem[] = [...items.values()]
    .sort((left, right) => left.sequence - right.sequence || left.outputIndex - right.outputIndex)
    .map((item) => ({ ...item, modelStepId: input.modelStepId }));
  const toolCalls: ToolCall[] = outputItems.flatMap((item) => {
    if (item.status !== "completed" || !item.callId || !item.toolName || (item.type !== "function" && item.type !== "custom")) return [];
    return [{
      argumentsText: item.type === "custom" ? JSON.stringify({ patch: item.draft ?? "" }) : item.argumentsText ?? "{}",
      callId: item.callId,
      index: item.outputIndex,
      name: item.toolName
    }];
  });
  const continuationMessage: ModelMessage = {
    continuationThinking: toolCalls.length > 0 ? thinking : undefined,
    outputItems,
    role: "assistant",
    text: answer || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
  };
  if (terminal === "failed" || terminal === "incomplete") throw new Error(terminalError);
  const unsealedCall = outputItems.find((item) => (item.type === "function" || item.type === "custom") && item.status !== "completed");
  return {
    answer,
    continuationMessage,
    finishCause: toolCalls.length > 0 ? "tool_calls" : "complete",
    protocolIssue: unsealedCall ? {
      code: "finish_mismatch",
      message: `DeepSeek Responses 在调用 ${unsealedCall.toolName ?? unsealedCall.itemId} 密封前结束。`,
      retryable: false
    } : terminal === "completed" ? undefined : {
      code: "incomplete_stream",
      message: "DeepSeek Responses SSE 流未收到终态事件。",
      retryable: false
    },
    thinking,
    toolCalls,
    usage
  };
}
