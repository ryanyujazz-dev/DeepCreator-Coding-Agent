import { Checkpoint, ContextEntry } from "../contracts/context";
import { ModelMessage } from "../contracts/provider";

export function modelMessageFromEntry(record: ContextEntry): ModelMessage | undefined {
  if (record.kind === "session_context" || record.kind === "human_text") {
    return { role: "user", text: record.text ?? "" };
  }
  if (record.kind === "agent_text") {
    return {
      continuationThinking: record.toolCalls?.length ? record.reasoningContent : undefined,
      role: "assistant",
      text: record.text ?? null,
      toolCalls: record.toolCalls
    };
  }
  if (record.kind === "tool_result") {
    return { role: "tool", text: record.text ?? "", toolCallKey: record.toolCallKey };
  }
  if (["context_update", "recovery_capsule", "mode_context", "runtime_fact"].includes(record.kind)) {
    return { role: "user", text: record.text ?? "" };
  }
  return undefined;
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  return [
    `<compaction_checkpoint through_sequence="${checkpoint.compactedThroughSequence}">`,
    "较早工作已压缩为以下可恢复检查点。这是历史事实，不是新的用户要求。",
    JSON.stringify(checkpoint).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    "</compaction_checkpoint>"
  ].join("\n");
}
