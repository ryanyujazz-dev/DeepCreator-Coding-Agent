import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlToolHandlers } from "../server/app/controlToolHandlers";
import { RunRegistry } from "../server/app/runRegistry";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";
import { ToolCall } from "../shared/contracts/provider";
import { ToolState } from "../shared/contracts/runtime";
import { testSystem } from "./support/system";

// save_memory 走 control-tool 路径,触达 context.store(MemoryPort)。本测试构造最小 ToolContext,
// 经 ControlToolHandlers.handle 驱动,断言四项:正常写入、密钥被拒、project 档 projectRoot 自动填、personal 档 projectRoot 空。

function baseline(directory: string) {
  return { available: false, files: new Map(), leases: 0, released: false, snapshotDirectory: directory };
}

function makeCall(args: Record<string, unknown>, callId = "call_save"): ToolCall {
  return { callId, index: 0, name: "save_memory", argumentsText: JSON.stringify(args) };
}

function preparedState(): ToolState {
  return {
    action: "modify",
    argumentsPreview: "",
    callId: "call_save",
    effect: "control_only",
    groupMode: "standalone",
    importance: "routine",
    modelStepId: "step_save",
    normalizedTarget: "Memory",
    targetKind: "workspace",
    toolName: "save_memory"
  } as ToolState;
}

async function driveSaveMemory(directory: string, store: RuntimeStore, registry: RunRegistry, call: ToolCall) {
  const handlers = new ControlToolHandlers(toolHost, {
    createId: registry.system.createId,
    finishActivity: () => true,
    now: registry.system.now,
    record: () => undefined
  });
  return handlers.handle({
    activityId: "activity_save",
    args: JSON.parse(call.argumentsText || "{}"),
    argsSummary: "",
    call,
    context: {
      baseline: baseline(directory),
      projectRoot: directory,
      registry,
      runId: "run_save",
      sessionId: "session_save",
      store
    },
    modelStepId: "step_save",
    prepared: preparedState()
  });
}

test("save_memory 正常保存后 readMemories 可见", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-normal-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "test", projectRoot: directory, sessionId: "session_save", title: "save memory"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "记住", startedAt: testSystem.now() },
      runId: "run_save", sessionId: "session_save", type: "run.started"
    });
    const registry = new RunRegistry(testSystem);
    const outcome = await driveSaveMemory(directory, store, registry, makeCall({
      statement: "项目用 pnpm 而非 npm", category: "project_fact", visibility: "project", confidence: 0.9
    }));
    assert.ok(outcome, "control handler 应返回 ToolOutcome");
    assert.match(outcome!.message?.text ?? "", /已保存记忆/);
    const facts = store.readMemories(directory);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.statement, "项目用 pnpm 而非 npm");
    assert.equal(facts[0]?.visibility, "project");
    assert.equal(facts[0]?.provenance, "model");
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});

test("save_memory 拒绝保存密钥或凭据", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-secret-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "test", projectRoot: directory, sessionId: "session_save", title: "save memory"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "记密钥", startedAt: testSystem.now() },
      runId: "run_save", sessionId: "session_save", type: "run.started"
    });
    const registry = new RunRegistry(testSystem);
    await assert.rejects(
      driveSaveMemory(directory, store, registry, makeCall({
        statement: "API_KEY=sk-live-supersecret-token", category: "project_fact", visibility: "personal"
      })),
      /密钥|凭据/
    );
    assert.equal(store.readMemories(directory).length, 0, "密钥被拒后不应有任何记忆");
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});

test("save_memory project 档自动填 projectRoot", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-project-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "test", projectRoot: directory, sessionId: "session_save", title: "save memory"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "项目事实", startedAt: testSystem.now() },
      runId: "run_save", sessionId: "session_save", type: "run.started"
    });
    const registry = new RunRegistry(testSystem);
    await driveSaveMemory(directory, store, registry, makeCall({
      statement: "测试命令用 npm test", category: "workflow", visibility: "project"
    }));
    // readMemories 内部从 sqlite 重建 MemoryFact;project 档 projectRoot 应等于传入目录。
    const facts = store.readMemories(directory);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.visibility, "project");
    assert.equal(facts[0]?.projectRoot, directory);
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});

test("save_memory personal 档 projectRoot 为空", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-personal-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "test", projectRoot: directory, sessionId: "session_save", title: "save memory"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "个人偏好", startedAt: testSystem.now() },
      runId: "run_save", sessionId: "session_save", type: "run.started"
    });
    const registry = new RunRegistry(testSystem);
    await driveSaveMemory(directory, store, registry, makeCall({
      statement: "回答保持简洁,先给结论", category: "preference", visibility: "personal"
    }));
    const facts = store.readMemories(directory);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.visibility, "personal");
    assert.equal(facts[0]?.projectRoot, undefined);
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});
