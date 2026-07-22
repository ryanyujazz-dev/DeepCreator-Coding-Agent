import assert from "node:assert/strict";
import test from "node:test";
import { ContextEntry } from "../shared/contracts/context";
import { missingToolResults, protocolSafeModelMessages } from "../shared/domain/toolProtocol";

function record(input: Partial<ContextEntry> & Pick<ContextEntry, "kind" | "recordId" | "sequence" | "source">): ContextEntry {
  return {
    createdAt: "2026-07-20T00:00:00.000Z",
    sessionId: "session_protocol",
    ...input
  };
}

test("repairs missing, delayed, and orphaned tool results into a provider-safe sequence", () => {
  const records: ContextEntry[] = [
    record({
      kind: "agent_text",
      recordId: "assistant_calls",
      runId: "run_protocol",
      sequence: 1,
      source: "model",
      toolCalls: [
        { argumentsText: "{}", callId: "call_b", index: 1, name: "git_status" },
        { argumentsText: "{}", callId: "call_a", index: 0, name: "list_files" }
      ]
    }),
    record({ kind: "human_text", recordId: "premature_user", sequence: 2, source: "user", text: "继续" }),
    record({ kind: "tool_result", recordId: "result_b", runId: "run_protocol", sequence: 3, source: "tool", text: "clean", toolCallKey: "call_b" }),
    record({ kind: "tool_result", recordId: "orphan", sequence: 4, source: "tool", text: "orphan", toolCallKey: "call_orphan" })
  ];

  assert.deepEqual(missingToolResults(records).map(({ call }) => call.callId), ["call_a"]);
  const messages = protocolSafeModelMessages(records);
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "tool", "user"]);
  assert.deepEqual(messages.slice(1, 3).map((message) => message.toolCallKey), ["call_a", "call_b"]);
  assert.match(messages[1].text ?? "", /视为已中断/);
  assert.equal(messages.some((message) => message.toolCallKey === "call_orphan"), false);
});
