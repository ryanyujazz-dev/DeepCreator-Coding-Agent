import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCycle } from "../server/agentRuntime";
import { prepareSessionContext } from "../server/contextManager";
import { ContextRecord } from "../server/contextRecords";
import { reduceToolEvidence } from "../server/evidenceReducer";
import { resolveInstructions } from "../server/instructionResolver";
import { LiveRegistry } from "../server/liveRegistry";
import { promptBlueprintRegistry } from "../server/promptBlueprintRegistry";
import { ProviderAdapter } from "../server/providerTypes";
import { SignalStore } from "../server/signalStore";
import { classifyInteraction } from "../server/toolRouting";
import { runtimeToolDefinitions } from "../server/tools";
import { settleWorkCycle } from "../server/cycleLifecycle";

function registerSession(store: SignalStore, directory: string, sessionKey: string, threshold = 850_000) {
  return store.registerSession({
    compactThresholdTokens: threshold,
    contextWindowTokens: 1_000_000,
    model: "deepseek-v4-flash",
    projectRoot: directory,
    sessionKey,
    title: "上下文测试"
  });
}

function acceptCycle(store: SignalStore, sessionKey: string, cycleKey: string, prompt: string): void {
  store.append({
    cycleKey,
    payload: { model: "deepseek-v4-flash", prompt, startedAt: new Date().toISOString() },
    sessionKey,
    topic: "cycle.accepted"
  });
}

test("routes greetings directly while recovery and coding follow-ups keep agent tools", () => {
  const now = new Date().toISOString();
  const session = {
    compactThresholdTokens: 850_000,
    contextTokenEstimate: 0,
    contextWindowTokens: 1_000_000,
    createdAt: now,
    cycleKeys: ["cycle_1"],
    cycles: [{
      approvals: [], cycleKey: "cycle_1", finalResponse: "已修改", lastOffset: 1, model: "test",
      phase: "succeeded" as const, plan: [], prompt: "修改代码", sessionKey: "session",
      startedAt: now, units: [{
        audience: "user" as const, body: "", cycleKey: "cycle_1", kind: "tool" as const,
        openedAt: now, phase: "succeeded" as const, title: "读取", unitKey: "unit_1",
        tool: {
          aggregationPolicy: "consecutive" as const, argumentsPreview: "", callKey: "call_1",
          detailPolicy: { defaultCollapsed: true, pathStyle: "workspace_relative" as const, previewLimit: 5 },
          displayTarget: "a.ts", effectKind: "read_only" as const, importance: "routine" as const,
          modelStepKey: "step", normalizedTarget: "a.ts", operationClass: "inspect" as const,
          resourceKind: "file" as const, toolName: "read_file"
        }
      }], workspaceDelta: { additions: 0, comparisonBase: "cycle_start" as const, deletions: 0, fileCount: 0, files: [] }
    }],
    lastOffset: 1,
    model: "test",
    permissionGrants: [],
    permissionProfile: "request_approval" as const,
    projectRoot: "/tmp/project",
    sessionKey: "session",
    title: "test",
    updatedAt: now
  };
  assert.equal(classifyInteraction("你好呀", session), "direct");
  assert.equal(classifyInteraction("继续", session), "recovery");
  assert.equal(classifyInteraction("还是不行", session), "recovery");
  assert.equal(classifyInteraction("解释一下量子纠缠", session), "direct");
  assert.equal(classifyInteraction("讲个笑话", session), "direct");
});

test("clamps compaction to the active provider context window", () => {
  const now = new Date().toISOString();
  const session = {
    compactThresholdTokens: 850_000, contextTokenEstimate: 2_000, contextWindowTokens: 1_000_000,
    createdAt: now, cycleKeys: [], cycles: [], lastOffset: 0, model: "deepseek-v4-flash",
    permissionGrants: [], permissionProfile: "request_approval" as const, projectRoot: "/tmp/project",
    sessionKey: "session", title: "test", updatedAt: now
  };
  const records: ContextRecord[] = Array.from({ length: 6 }, (_, index) => ({
    createdAt: now,
    kind: index % 2 === 0 ? "human_text" as const : "agent_text" as const,
    recordKey: `record_${index}`,
    sequence: index + 1,
    sessionKey: "session",
    source: index % 2 === 0 ? "user" as const : "model" as const,
    text: `${"context".repeat(250)}-${index}`
  }));
  const prepared = prepareSessionContext({
    currentCycleKey: "cycle", model: "deepseek-v4-flash", projectRoot: "/tmp/project",
    prompt: "继续", providerContextWindowTokens: 2_000, records, session, tools: runtimeToolDefinitions
  });
  assert.equal(prepared.windowTokens, 2_000);
  assert.equal(prepared.thresholdTokens, 1);
  assert.equal(prepared.compacted, true);
});

test("resolves broad, local, path-scoped, and nested instructions with provenance", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-instructions-"));
  try {
    mkdirSync(path.join(directory, ".deepseeker", "rules"), { recursive: true });
    mkdirSync(path.join(directory, "src", "feature"), { recursive: true });
    writeFileSync(path.join(directory, "DEEPSEEKER.md"), "项目规则", "utf8");
    writeFileSync(path.join(directory, "DEEPSEEKER.local.md"), "本地规则", "utf8");
    writeFileSync(path.join(directory, "src", "feature", "DEEPSEEKER.md"), "功能目录规则", "utf8");
    writeFileSync(path.join(directory, ".deepseeker", "rules", "typescript.md"), [
      "---", "paths:", "  - 'src/**/*.ts'", "---", "TypeScript 路径规则"
    ].join("\n"), "utf8");
    const instructions = resolveInstructions({ activePaths: ["src/feature/view.ts"], projectRoot: directory });
    assert.ok(instructions.some((item) => item.text === "项目规则" && item.scope === "project"));
    assert.ok(instructions.some((item) => item.text === "本地规则" && item.scope === "local"));
    assert.ok(instructions.some((item) => item.text === "功能目录规则" && item.reason.includes("按需")));
    assert.ok(instructions.some((item) => item.text === "TypeScript 路径规则" && item.appliesTo[0] === "src/**/*.ts"));
    assert.ok(instructions.every((item) => item.hash.length === 64 && item.sourcePath.length > 0));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("keeps cache prefix stable when only runtime state and latest user text change", () => {
  const now = new Date().toISOString();
  const session = {
    compactThresholdTokens: 850_000, contextTokenEstimate: 0, contextWindowTokens: 1_000_000,
    createdAt: now, cycleKeys: [], cycles: [], lastOffset: 0, model: "deepseek-v4-flash",
    permissionGrants: [], permissionProfile: "request_approval" as const, projectRoot: "/tmp/project",
    sessionKey: "session", title: "test", updatedAt: now
  };
  const base = {
    currentCycleKey: "cycle", model: "deepseek-v4-flash", projectRoot: "/tmp/project",
    records: [] as ContextRecord[], session, tools: runtimeToolDefinitions
  };
  const first = prepareSessionContext({ ...base, prompt: "修改 a.ts" });
  const second = prepareSessionContext({ ...base, prompt: "继续修改 b.ts" });
  assert.equal(first.telemetry.prefixHash, second.telemetry.prefixHash);
  assert.equal(first.messages.at(-2)?.role, "system");
  assert.match(first.messages.at(-2)?.text ?? "", /Runtime 当前事实/);
  assert.equal(first.messages.at(-1)?.text, "修改 a.ts");
});

test("compacts old records into a structured checkpoint without preserving reasoning", () => {
  const now = new Date().toISOString();
  const session = {
    compactThresholdTokens: 500, contextTokenEstimate: 1_000, contextWindowTokens: 1_000_000,
    createdAt: now, cycleKeys: ["cycle_old"], cycles: [{
      approvals: [], cycleKey: "cycle_old", failure: "旧构建失败", finalResponse: "仍需修复", lastOffset: 1,
      model: "deepseek-v4-flash", phase: "failed" as const,
      plan: [
        { label: "读取入口", state: "completed" as const, stepKey: "step_read" },
        { label: "修复构建", state: "in_progress" as const, stepKey: "step_fix" }
      ],
      prompt: "必须保持事件协议。", sessionKey: "session", startedAt: now, units: [],
      workspaceDelta: {
        additions: 4, comparisonBase: "cycle_start" as const, deletions: 1, fileCount: 1,
        files: [{ additions: 4, deletions: 1, operation: "edited" as const, path: "src/runtime.ts" }]
      }
    }], lastOffset: 0, model: "deepseek-v4-flash",
    permissionGrants: [], permissionProfile: "request_approval" as const, projectRoot: "/tmp/project",
    sessionKey: "session", title: "test", updatedAt: now
  };
  const records: ContextRecord[] = [];
  for (let index = 0; index < 8; index += 1) {
    records.push({
      createdAt: now, kind: "human_text", recordKey: `human_${index}`, sequence: records.length + 1,
      sessionKey: "session", source: "user", text: `${index === 0 ? "必须保持事件协议。" : "继续任务"}${"x".repeat(400)}`
    });
    records.push({
      createdAt: now, kind: "agent_text", reasoningContent: "不应进入检查点的思维链",
      recordKey: `agent_${index}`, sequence: records.length + 1, sessionKey: "session", source: "model",
      text: `决定采用结构化上下文。${"y".repeat(400)}`
    });
    if (index === 0) {
      records.push({
        artifactRef: "context-artifact://session/verify", createdAt: now, kind: "tool_result",
        metadata: { operationClass: "verify", originalBytes: 50_000, retainedBytes: 12_000, target: "src/runtime.ts" },
        recordKey: "verify_old", sequence: records.length + 1, sessionKey: "session", source: "tool",
        text: "npm test 退出码 0", toolCallKey: "call_verify", toolName: "run_command", wasTruncated: true
      });
    }
  }
  const prepared = prepareSessionContext({
    currentCycleKey: "cycle_new", model: "deepseek-v4-flash", projectRoot: "/tmp/project",
    prompt: "继续", records, session, tools: runtimeToolDefinitions
  });
  assert.equal(prepared.compacted, true);
  assert.ok(prepared.checkpoint?.constraints.some((item) => item.includes("保持事件协议")));
  assert.ok(prepared.checkpoint?.decisions.some((item) => item.includes("结构化上下文")));
  assert.ok(prepared.checkpoint?.changedFiles.includes("src/runtime.ts"));
  assert.ok(prepared.checkpoint?.validations.some((item) => item.includes("退出码 0")));
  assert.ok(prepared.checkpoint?.failures.includes("旧构建失败"));
  assert.deepEqual(prepared.checkpoint?.pendingWork, ["修复构建"]);
  assert.doesNotMatch(JSON.stringify(prepared.checkpoint), /思维链/);
  assert.ok(prepared.retainedRecords.length < records.length);
  assert.ok((prepared.telemetry.compactBeforeTokens ?? 0) > (prepared.telemetry.compactAfterTokens ?? 0));
  assert.ok(prepared.telemetry.droppedRecords.length > 0);
  assert.equal(prepared.telemetry.truncationEvents[0]?.recordKey, "verify_old");
});

test("reduces oversized evidence with explicit truncation and secret redaction", () => {
  process.env.TEST_CONTEXT_SECRET = "a-very-sensitive-token-value";
  try {
    const evidence = reduceToolEvidence("run_command", {
      command: "npm test",
      exitCode: 0,
      mutatedWorkspace: false,
      output: `head\na-very-sensitive-token-value\n${"middle".repeat(5_000)}\ntail`
    });
    assert.equal(evidence.wasTruncated, true);
    assert.match(evidence.modelText, /中间内容已由 Runtime 裁剪/);
    assert.match(evidence.modelText, /退出码：0/);
    assert.match(evidence.modelText, /tail/);
    assert.doesNotMatch(evidence.fullText, /a-very-sensitive-token-value/);
  } finally {
    delete process.env.TEST_CONTEXT_SECRET;
  }
});

test("persists DeepSeek tool reasoning across cycles but drops ordinary final reasoning", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-context-loop-"));
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const value = 1;\n", "utf8");
    const store = new SignalStore(directory);
    registerSession(store, directory, "session_context");
    let firstToolRequested = false;
    let sawRetainedToolReasoning = false;
    const provider: ProviderAdapter = {
      capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: false, supportsThinking: true, supportsTools: true },
      async stream(request) {
        const latestUser = [...request.messages].reverse().find((message) => message.role === "user")?.text;
        if (latestUser === "读取 sample.ts" && !request.messages.some((message) => message.role === "tool")) {
          firstToolRequested = true;
          return {
            answer: "我先读取文件。",
            continuationMessage: {
              continuationThinking: "必须随工具轨迹保留",
              role: "assistant",
              text: "我先读取文件。",
              toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callKey: "call_read", index: 0, name: "read_file" }]
            },
            finishCause: "tool_calls",
            thinking: "必须随工具轨迹保留",
            toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callKey: "call_read", index: 0, name: "read_file" }]
          };
        }
        if (latestUser === "刚才读取了什么文件") {
          const toolAssistantIndex = request.messages.findIndex((message) =>
            message.role === "assistant" && message.toolCalls?.length && message.continuationThinking === "必须随工具轨迹保留"
          );
          sawRetainedToolReasoning = toolAssistantIndex >= 0;
          assert.equal(request.messages[toolAssistantIndex + 1]?.role, "tool");
          assert.equal(request.messages[toolAssistantIndex + 1]?.toolCallKey, "call_read");
        }
        return {
          answer: "检查完成",
          continuationMessage: { continuationThinking: "普通最终思考不应持久化", role: "assistant", text: "检查完成" },
          finishCause: "complete",
          thinking: "普通最终思考不应持久化",
          toolCalls: []
        };
      }
    };
    const registry = new LiveRegistry();
    acceptCycle(store, "session_context", "cycle_one", "读取 sample.ts");
    await runAgentCycle({
      cycleKey: "cycle_one", model: "deepseek-v4-flash", projectRoot: directory, prompt: "读取 sample.ts",
      provider, registry, sessionKey: "session_context", signal: registry.startCycle("cycle_one").signal, store
    });
    acceptCycle(store, "session_context", "cycle_two", "刚才读取了什么文件");
    await runAgentCycle({
      cycleKey: "cycle_two", model: "deepseek-v4-flash", projectRoot: directory, prompt: "刚才读取了什么文件",
      provider, registry, sessionKey: "session_context", signal: registry.startCycle("cycle_two").signal, store
    });
    assert.equal(firstToolRequested, true);
    assert.equal(sawRetainedToolReasoning, true);
    const records = store.readContextRecords("session_context");
    assert.ok(records.some((record) => record.reasoningContent === "必须随工具轨迹保留" && record.toolCalls?.length));
    assert.ok(!records.some((record) => record.reasoningContent === "普通最终思考不应持久化"));
    assert.ok(records.some((record) => record.kind === "tool_result" && record.artifactRef));
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("records context telemetry without recording full reasoning content", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-telemetry-"));
  try {
    process.env.DEEPSEEK_CONTEXT_DEBUG = "1";
    const store = new SignalStore(directory);
    registerSession(store, directory, "session_telemetry");
    acceptCycle(store, "session_telemetry", "cycle_telemetry", "你好呀");
    const provider: ProviderAdapter = {
      capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: false, supportsThinking: true, supportsTools: true },
      async stream(request) {
        assert.equal(request.tools.length, 0);
        return {
          answer: "你好",
          continuationMessage: { role: "assistant", text: "你好" },
          finishCause: "complete",
          thinking: "不进入遥测",
          toolCalls: [],
          usage: { cacheHitTokens: 80, cacheMissTokens: 20, inputTokens: 100, outputTokens: 4 }
        };
      }
    };
    const registry = new LiveRegistry();
    await runAgentCycle({
      cycleKey: "cycle_telemetry", model: "deepseek-v4-flash", projectRoot: directory, prompt: "你好呀",
      provider, registry, sessionKey: "session_telemetry", signal: registry.startCycle("cycle_telemetry").signal, store
    });
    const telemetry = store.readContextTelemetry("session_telemetry");
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].cacheHitTokens, 80);
    assert.equal(telemetry[0].cacheMissTokens, 20);
    assert.ok(telemetry[0].sections.some((section) => section.section === "latest_user"));
    assert.doesNotMatch(JSON.stringify(telemetry), /不进入遥测/);
    const debugPath = path.join(directory, "context-debug", "session_telemetry", "cycle_telemetry.json");
    assert.equal(existsSync(debugPath), true);
    const debug = JSON.parse(readFileSync(debugPath, "utf8")) as { layout: unknown[]; messageRoles: string[] };
    assert.ok(debug.layout.length > 0);
    assert.deepEqual(debug.messageRoles.slice(-2), ["system", "user"]);
    store.close();
  } finally {
    delete process.env.DEEPSEEK_CONTEXT_DEBUG;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("injects failed-cycle recovery facts immediately before a continue request", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-recovery-context-"));
  try {
    const store = new SignalStore(directory);
    registerSession(store, directory, "session_recovery");
    acceptCycle(store, "session_recovery", "cycle_failed", "修改项目");
    store.append({ cycleKey: "cycle_failed", payload: {}, sessionKey: "session_recovery", topic: "cycle.executing" });
    settleWorkCycle({
      cycleKey: "cycle_failed",
      failure: "构建失败",
      failureType: "runtime_error",
      finalResponse: "本轮失败",
      phase: "failed",
      projectRoot: directory,
      sessionKey: "session_recovery",
      store
    });
    acceptCycle(store, "session_recovery", "cycle_continue", "继续");
    let sawRecovery = false;
    const provider: ProviderAdapter = {
      capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: false, supportsThinking: true, supportsTools: true },
      async stream(request) {
        assert.ok(request.tools.length > 0);
        const runtimeIndex = request.messages.findIndex((message) => message.role === "system" && message.text?.includes("Runtime 当前事实"));
        assert.equal(runtimeIndex, request.messages.length - 2);
        assert.match(request.messages[runtimeIndex].text ?? "", /构建失败/);
        assert.equal(request.messages.at(-1)?.text, "继续");
        sawRecovery = true;
        return {
          answer: "恢复完成",
          continuationMessage: { role: "assistant", text: "恢复完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const registry = new LiveRegistry();
    await runAgentCycle({
      cycleKey: "cycle_continue", model: "deepseek-v4-flash", projectRoot: directory, prompt: "继续",
      provider, registry, sessionKey: "session_recovery", signal: registry.startCycle("cycle_continue").signal, store
    });
    assert.equal(sawRecovery, true);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("keeps prompt blueprints versioned, model-addressable, and hash-stable", () => {
  const first = promptBlueprintRegistry.compileSystem("deepseek-v4-flash");
  const second = promptBlueprintRegistry.compileSystem("deepseek-v4-flash");
  assert.equal(first.hash, second.hash);
  assert.match(first.version, /identity@1\.0\.0/);
  assert.match(first.text, /结构化 tool_calls/);
  assert.doesNotMatch(first.text, /项目根目录/);
});

test("persists the private context ledger independently from public signals", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-context-store-"));
  try {
    const first = new SignalStore(directory);
    registerSession(first, directory, "session_persisted_context");
    first.appendContextRecord({
      cycleKey: "cycle_private",
      kind: "runtime_fact",
      metadata: { source: "test" },
      sessionKey: "session_persisted_context",
      source: "runtime",
      text: "仅供模型恢复的事实"
    });
    assert.equal(first.readSignals("session_persisted_context").some((signal) => JSON.stringify(signal).includes("仅供模型恢复")), false);
    first.close();
    const second = new SignalStore(directory);
    const records = second.readContextRecords("session_persisted_context");
    assert.equal(records.at(-1)?.text, "仅供模型恢复的事实");
    assert.equal(records.at(-1)?.kind, "runtime_fact");
    second.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
