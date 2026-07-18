import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../server/app/runner";
import { RunRegistry } from "../server/app/runRegistry";
import { Provider } from "../shared/contracts/provider";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";

test("recovers a transient provider failure before any stream fragment", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-"));
  try {
    let attempts = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        attempts += 1;
        if (attempts === 1) throw new Error("DeepSeek API 请求失败：503 unavailable");
        request.onFragment?.({ kind: "answer", text: "恢复成功" });
        return {
          answer: "恢复成功",
          continuationMessage: { role: "assistant", text: "恢复成功" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_retry", title: "重试" });
    store.append({ runId: "run_retry", data: { model: "test", prompt: "你好", startedAt: new Date().toISOString() }, sessionId: "session_retry", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_retry");
    await runAgent({ tools: toolHost, runId: "run_retry", model: "test", projectRoot: directory, prompt: "你好", provider, registry, sessionId: "session_retry", signal: controller.signal, store });
    const run = store.getRun("run_retry")!;
    assert.equal(attempts, 2);
    assert.equal(run.status, "completed");
    assert.equal(run.answer, "恢复成功");
    assert.ok(run.activities.some((activity) => activity.title === "正在恢复模型连接"));
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("persists semantic tool facts while provider schemas stay presentation-free", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-tool-"));
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    let turn = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        turn += 1;
        assert.ok(request.tools.every((tool) => !("presentation" in tool)));
        if (turn === 1) {
          request.onFragment?.({
            argumentsText: "{\"path\":\"sample.ts\"}",
            callId: "call_read",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callId: "call_read", index: 0, name: "read_file" }]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callId: "call_read", index: 0, name: "read_file" }]
          };
        }
        request.onFragment?.({ kind: "answer", text: "检查完成" });
        return {
          answer: "检查完成",
          continuationMessage: { role: "assistant", text: "检查完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_tool", title: "工具语义" });
    store.append({ runId: "run_tool", data: { model: "test", prompt: "读取代码文件", startedAt: new Date().toISOString() }, sessionId: "session_tool", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_tool");
    await runAgent({ tools: toolHost, runId: "run_tool", model: "test", projectRoot: directory, prompt: "读取代码文件", provider, registry, sessionId: "session_tool", signal: controller.signal, store });
    const run = store.getRun("run_tool")!;
    const readUnit = run.activities.find((activity) => activity.tool?.callId === "call_read");
    assert.equal(readUnit?.kind, "tool");
    assert.equal(readUnit?.tool?.action, "inspect");
    assert.equal(readUnit?.tool?.normalizedTarget, "sample.ts");
    assert.equal(readUnit?.tool?.resultMetrics?.itemCount, 1);
    assert.ok(readUnit?.tool?.modelStepId.startsWith("model_step_"));
    assert.ok(store.readEvents("session_tool").some((event) => event.type === "activity.updated"));
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
