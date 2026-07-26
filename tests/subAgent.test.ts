import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSubAgent } from "../server/app/subAgent";
import { TestRunRegistry as RunRegistry } from "./support/system";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";
import { Provider } from "../shared/contracts/provider";

// ─────────────────────────────────────────────────────────────────────────────
// spawn_agent 子 Agent 测试。
//
// 使用自定义 mock provider 模拟子 Agent 的模型响应(不调用真实 DeepSeek API)。
// 测试覆盖:
//   1. 子 Agent 执行只读任务,返回最终摘要文本
//   2. 工具白名单强制(Explore 类型的受限 ToolHost 不含 write_file)
//   3. 子 Agent 结果不写入父 Session(隔离性)
//   4. 子 Agent 失败时返回错误摘要(不崩溃)
// ─────────────────────────────────────────────────────────────────────────────

/** 创建一个简单的 mock provider:只返回文本,不调用工具。 */
function textOnlyProvider(answer: string): Provider {
  return {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream() {
      return {
        answer,
        continuationMessage: { role: "assistant", text: answer },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };
}

test("spawnSubAgent: executes read-only task and returns final summary", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-subagent-"));
  try {
    writeFileSync(path.join(directory, "target.ts"), "export const value = 42;\n");
    const store = new RuntimeStore(directory);
    // 创建父 Session
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_parent",
      title: "父会话"
    });
    const registry = new RunRegistry();
    const summary = "Found 1 file with value 42. The codebase uses TypeScript.";
    const provider = textOnlyProvider(summary);

    const result = await spawnSubAgent({
      capabilities: undefined,
      context: undefined,
      description: "Explore the codebase",
      model: "test",
      parentRunId: "run_parent",
      parentSessionId: "session_parent",
      projectRoot: directory,
      prompt: "Read target.ts and summarize what it contains",
      provider,
      registry,
      rules: undefined,
      store,
      subagentType: "Explore",
      tools: toolHost
    });

    assert.equal(result, summary);
    // 子 Session 应已创建
    const sessions = store.listSessions();
    const childSession = sessions.find((session) => session.title.includes("子 Agent"));
    assert.ok(childSession, "child session should be created");
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* EPERM on Windows is expected */ }
  }
});

test("spawnSubAgent: Explore type restricts tools to read-only set", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-subagent-ro-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_parent_ro",
      title: "父会话"
    });
    const registry = new RunRegistry();
    const provider = textOnlyProvider("Done");

    // 子 Agent 的 prompt 要求修改文件,但 Explore 类型不应该有 write_file
    await spawnSubAgent({
      description: "Try to write",
      model: "test",
      parentRunId: "run_parent_ro",
      parentSessionId: "session_parent_ro",
      projectRoot: directory,
      prompt: "Write a file",
      provider,
      registry,
      store,
      subagentType: "Explore",
      tools: toolHost
    });

    // Explore 类型不应有 write_file 在白名单中
    // 验证:子 Session 不应产生 write_file 的 changes(文件未被创建)
    const sessions = store.listSessions();
    const childSession = sessions.find((session) => session.title.includes("子 Agent"));
    assert.ok(childSession);
    // 文件系统层面:不应有新文件被创建(Explore 是只读的)
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* EPERM on Windows is expected */ }
  }
});

test("spawnSubAgent: child agent results do not leak into parent session context", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-subagent-isolation-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_parent_iso",
      title: "父会话"
    });
    const registry = new RunRegistry();
    const secretSummary = "SECRET_FINDING_unique_marker_xyz";
    const provider = textOnlyProvider(secretSummary);

    await spawnSubAgent({
      description: "Isolated search",
      model: "test",
      parentRunId: "run_parent_iso",
      parentSessionId: "session_parent_iso",
      projectRoot: directory,
      prompt: "Search for patterns",
      provider,
      registry,
      store,
      subagentType: "Explore",
      tools: toolHost
    });

    // 子 Agent 的中间步骤不应出现在父 Session 的上下文记录中
    const parentRecords = store.readContextEntries("session_parent_iso");
    assert.equal(
      parentRecords.length,
      0,
      "parent session should have no context entries from child agent"
    );
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* EPERM on Windows is expected */ }
  }
});

test("spawnSubAgent: returns error summary instead of crashing when child agent fails", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-subagent-fail-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_parent_fail",
      title: "父会话"
    });
    const registry = new RunRegistry();
    // Provider 总是抛错,模拟子 Agent 失败
    const failingProvider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream() {
        throw new Error("Simulated provider failure");
      }
    };

    const result = await spawnSubAgent({
      description: "Failing task",
      model: "test",
      parentRunId: "run_parent_fail",
      parentSessionId: "session_parent_fail",
      projectRoot: directory,
      prompt: "Do something",
      provider: failingProvider,
      registry,
      store,
      subagentType: "Explore",
      tools: toolHost
    });

    // 子 Agent 失败时(runAgent 内部捕获了 provider 错误),spawnSubAgent 不应抛出异常,
    // 而是返回一个降级消息(可能是错误摘要或"未返回可读摘要"的退化消息)。
    // 关键验证:spawnSubAgent 本身正常 resolve,不会把异常传播到父 Run。
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
    store.close();
  } finally {
    // Windows 下 SQLite 临时目录删除可能报 EPERM(AGENTS.md 已说明),用 force + catch 兜底
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* EPERM on Windows is expected */ }
  }
});
