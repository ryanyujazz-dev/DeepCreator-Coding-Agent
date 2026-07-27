import { Checkpoint, ContextEntry, SystemReminderType } from "../contracts/context";
import { ModelMessage } from "../contracts/provider";

// ─────────────────────────────────────────────────────────────────────────────
// ADR-007: 统一 <system-reminder> 标签构建器
//
// 所有运行时注入的信封都使用 <system-reminder type="..."> 格式,
// 替换原有的 <stable_session_context> / <mode_context> / <recovery_capsule> /
// <compaction_checkpoint> / 裸文本 context_update。
// ─────────────────────────────────────────────────────────────────────────────

/** 构建统一格式的 system-reminder 消息文本 */
export function systemReminder(type: SystemReminderType, body: string): string {
  return `<system-reminder type="${type}">\n${body}\n</system-reminder>`;
}

/** 构建带 revision 指纹的 system-reminder(用于 L1 session 层,可检测内容漂移) */
export function systemReminderWithRevision(
  type: SystemReminderType,
  revision: string,
  body: string
): string {
  return `<system-reminder type="${type}" revision="${revision}">\n${body}\n</system-reminder>`;
}

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
  if (["context_update", "recovery_capsule", "mode_context", "runtime_fact", "delegation_result"].includes(record.kind)) {
    return { role: "user", text: record.text ?? "" };
  }
  return undefined;
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  const escaped = JSON.stringify(checkpoint).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return systemReminder("checkpoint", `through_sequence="${checkpoint.compactedThroughSequence}"\n早期工作已压缩为可恢复的检查点。这是历史事实，不是新的用户请求。\n${escaped}`);
}
