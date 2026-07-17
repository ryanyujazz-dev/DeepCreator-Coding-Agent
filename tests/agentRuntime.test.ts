import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCycle } from "../server/agentRuntime";
import { LiveRegistry } from "../server/liveRegistry";
import { ProviderAdapter } from "../server/providerTypes";
import { SignalStore } from "../server/signalStore";

test("recovers a transient provider failure before any stream fragment", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-"));
  try {
    let attempts = 0;
    const provider: ProviderAdapter = {
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
    const store = new SignalStore(directory);
    store.registerSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionKey: "session_retry", title: "重试" });
    store.append({ cycleKey: "cycle_retry", payload: { model: "test", prompt: "你好", startedAt: new Date().toISOString() }, sessionKey: "session_retry", topic: "cycle.accepted" });
    const registry = new LiveRegistry();
    const controller = registry.startCycle("cycle_retry");
    await runAgentCycle({ cycleKey: "cycle_retry", model: "test", projectRoot: directory, prompt: "你好", provider, registry, sessionKey: "session_retry", signal: controller.signal, store });
    const cycle = store.getCycle("cycle_retry")!;
    assert.equal(attempts, 2);
    assert.equal(cycle.phase, "succeeded");
    assert.equal(cycle.finalResponse, "恢复成功");
    assert.ok(cycle.units.some((unit) => unit.title === "正在恢复模型连接"));
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
    const provider: ProviderAdapter = {
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
            callKey: "call_read",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callKey: "call_read", index: 0, name: "read_file" }]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callKey: "call_read", index: 0, name: "read_file" }]
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
    const store = new SignalStore(directory);
    store.registerSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionKey: "session_tool", title: "工具语义" });
    store.append({ cycleKey: "cycle_tool", payload: { model: "test", prompt: "读取代码文件", startedAt: new Date().toISOString() }, sessionKey: "session_tool", topic: "cycle.accepted" });
    const registry = new LiveRegistry();
    const controller = registry.startCycle("cycle_tool");
    await runAgentCycle({ cycleKey: "cycle_tool", model: "test", projectRoot: directory, prompt: "读取代码文件", provider, registry, sessionKey: "session_tool", signal: controller.signal, store });
    const cycle = store.getCycle("cycle_tool")!;
    const readUnit = cycle.units.find((unit) => unit.tool?.callKey === "call_read");
    assert.equal(readUnit?.kind, "tool");
    assert.equal(readUnit?.tool?.operationClass, "inspect");
    assert.equal(readUnit?.tool?.normalizedTarget, "sample.ts");
    assert.equal(readUnit?.tool?.resultMetrics?.itemCount, 1);
    assert.ok(readUnit?.tool?.modelStepKey.startsWith("model_step_"));
    assert.ok(store.readSignals("session_tool").some((signal) => signal.topic === "unit.tool.updated"));
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
