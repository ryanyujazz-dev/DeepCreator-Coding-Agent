import { ContextEntry, modelMessageFromEntry } from "../contracts/context";
import { ModelMessage, ToolCall } from "../contracts/provider";

export type MissingToolResult = {
  assistant: ContextEntry;
  call: ToolCall;
};

function orderedCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return [...calls]
    .sort((left, right) => left.index - right.index)
    .filter((call) => {
      if (!call.callId || !call.name || seen.has(call.callId)) return false;
      seen.add(call.callId);
      return true;
    });
}

function resultMatchesAssistant(result: ContextEntry, assistant: ContextEntry): boolean {
  return result.sequence > assistant.sequence && (
    !assistant.runId || !result.runId || result.runId === assistant.runId
  );
}

export function missingToolResults(records: ContextEntry[]): MissingToolResult[] {
  const results = records.filter((record) => record.kind === "tool_result" && record.toolCallKey);
  return [...records]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((record) => record.kind === "agent_text" && Boolean(record.toolCalls?.length))
    .flatMap((assistant) => orderedCalls(assistant.toolCalls ?? [])
      .filter((call) => !results.some((result) => (
        result.toolCallKey === call.callId && resultMatchesAssistant(result, assistant)
      )))
      .map((call) => ({ assistant, call })));
}

export function protocolSafeModelMessages(records: ContextEntry[]): ModelMessage[] {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const results = ordered.filter((record) => record.kind === "tool_result" && record.toolCallKey);
  const consumedResults = new Set<string>();
  const messages: ModelMessage[] = [];

  for (const record of ordered) {
    if (record.kind === "tool_result") continue;
    const message = modelMessageFromEntry(record);
    if (!message) continue;
    if (record.kind !== "agent_text" || !record.toolCalls?.length) {
      messages.push(message);
      continue;
    }

    const calls = orderedCalls(record.toolCalls);
    if (calls.length === 0) {
      messages.push({ role: "assistant", text: message.text });
      continue;
    }
    messages.push({ ...message, toolCalls: calls });
    for (const call of calls) {
      const result = results.find((candidate) => (
        !consumedResults.has(candidate.recordId) &&
        candidate.toolCallKey === call.callId &&
        resultMatchesAssistant(candidate, record)
      ));
      if (result) {
        consumedResults.add(result.recordId);
        messages.push(modelMessageFromEntry(result)!);
        continue;
      }
      messages.push({
        role: "tool",
        text: `工具调用 ${call.name} (${call.callId}) 没有持久化结果，Runtime 将其视为已中断；不得假设该工具执行成功。`,
        toolCallKey: call.callId
      });
    }
  }

  return messages;
}
