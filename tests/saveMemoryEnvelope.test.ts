import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { envelopeSection, prepareSessionContext } from "../server/app/contextBuilder";
import { ContextEntry } from "../shared/contracts/context";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolSpecs } from "../server/infra/tools";
import { ruleSource } from "../server/infra/rules";
import { Session } from "../shared/contracts/runtime";
import { testSystem } from "./support/system";

// 验证 save_memory 的缓存保护不变量(批次 2.4 计划验证第 7 项):
//   ① 写入立即持久(memoryDigest 立刻可见)
//   ② 当前会话信封冻结——同一会话下一轮 <memory-index> 不变,prefixHash 不变(缓存命中保护)
//   ③ 新会话起点才重建信封——<memory-index> 含新记忆
// 驱动路径与真实运行时一致:memoryIndex = store.memoryDigest(projectRoot),records = store.readContextEntries,
//   且每轮把 prepared.sessionEnvelopeRecord 持久化(对应 runtimeContext.persistPreparedContext 第 113 行)。

const sessionDefaults: Pick<Session, "followUps" | "mode" | "planEntry" | "plans" | "questions" | "workspaceKind"> = {
  followUps: [], mode: "work", planEntry: "suggest", plans: [], questions: [], workspaceKind: "project"
};

function makeSession(sessionId: string, projectRoot: string): Session {
  const now = new Date().toISOString();
  return {
    ...sessionDefaults,
    compactThresholdTokens: 850_000, contextTokens: 0, contextWindowTokens: 1_000_000,
    createdAt: now, runIds: [], runs: [], lastOffset: 0, model: "deepseek-v4-flash",
    grants: [], accessMode: "full_access" as const, projectRoot, sessionId, title: "envelope-freeze", updatedAt: now
  };
}

function memoryIndexOf(prepared: ReturnType<typeof prepareSessionContext>): string {
  // 信封是 messages 中第二个 user 消息(system 在 [0],信封在 [1])。
  const envelope = prepared.messages.find((message) => message.role === "user" && (message.text ?? "").includes("memory-index"));
  assert.ok(envelope, "应存在含 memory-index 的信封消息");
  return envelopeSection(envelope.text ?? "", "memory_index");
}

test("save_memory:当前会话 <memory-index> 冻结、新会话才刷新(缓存保护)", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-envelope-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    const projectRoot = directory;
    const session = makeSession("session_a", projectRoot);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "deepseek-v4-flash", projectRoot, sessionId: session.sessionId, title: "envelope-freeze"
    });

    // --- 第一轮(session A,尚无记忆):构建并持久化初始信封 ---
    const turn1 = prepareSessionContext({
      runId: "run_a1", model: "deepseek-v4-flash", projectRoot,
      records: store.readContextEntries(session.sessionId),
      memoryIndex: store.memoryDigest(projectRoot),
      session, rules: ruleSource, system: testSystem, tools: toolSpecs, prompt: "你好"
    });
    assert.ok(turn1.sessionEnvelopeRecord, "首轮应生成 sessionEnvelopeRecord(无既有信封→重建)");
    assert.equal(memoryIndexOf(turn1), "当前没有生效的结构化记忆事实。", "首轮记忆索引应为空占位");
    const prefixBefore = turn1.telemetry.prefixHash;
    store.appendContextEntry(turn1.sessionEnvelopeRecord!); // 持久化冻结信封(对应 persistPreparedContext)

    // --- save_memory 写入(走与 ControlToolHandlers.saveMemory 同一的 store.saveMemory)---
    store.saveMemory({
      statement: "项目用 pnpm 而非 npm", category: "project_fact", confidence: 0.9,
      provenance: "model", visibility: "project", projectRoot
    });
    // ① 立即持久:memoryDigest 立刻可见
    assert.match(store.memoryDigest(projectRoot), /pnpm/);

    // --- 第二轮(session A,同一会话下一轮):既有信封命中 → 冻结 ---
    const turn2 = prepareSessionContext({
      runId: "run_a2", model: "deepseek-v4-flash", projectRoot,
      records: store.readContextEntries(session.sessionId), // 现在含首轮持久化的 session_context
      memoryIndex: store.memoryDigest(projectRoot),          // 已含 pnpm,但应被冻结信封忽略
      session, rules: ruleSource, system: testSystem, tools: toolSpecs, prompt: "继续"
    });
    // ② 当前会话不刷新
    assert.equal(turn2.sessionEnvelopeRecord, undefined, "同一会话无压缩时不应重建信封(refreshEnvelope=false)");
    assert.equal(memoryIndexOf(turn2), "当前没有生效的结构化记忆事实。", "当前会话记忆索引应保持冻结(不含 pnpm)");
    assert.doesNotMatch(memoryIndexOf(turn2), /pnpm/, "冻结信封不得泄露刚写入的记忆");
    assert.equal(turn2.telemetry.prefixHash, prefixBefore, "prefixHash 不变 → Anthropic 前缀缓存命中被保护");

    // --- 新会话(session B,起点):无既有信封 → 重建 → 含新记忆 ---
    const sessionB = makeSession("session_b", projectRoot);
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000,
      model: "deepseek-v4-flash", projectRoot, sessionId: sessionB.sessionId, title: "envelope-freeze-b"
    });
    const turnB = prepareSessionContext({
      runId: "run_b1", model: "deepseek-v4-flash", projectRoot,
      records: store.readContextEntries(sessionB.sessionId), // B 无任何记录
      memoryIndex: store.memoryDigest(projectRoot),
      session: sessionB, rules: ruleSource, system: testSystem, tools: toolSpecs, prompt: "新会话"
    });
    // ③ 新会话刷新
    assert.ok(turnB.sessionEnvelopeRecord, "新会话起点应重建信封");
    assert.match(memoryIndexOf(turnB), /pnpm/, "新会话起点记忆索引应含刚写入的记忆");
    assert.notEqual(turnB.telemetry.prefixHash, prefixBefore, "新会话 prefixHash 应不同(信封已变)");

    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});

test("save_memory:压缩触发后当前会话信封才重建(冻结的第二解锁条件)", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-save-memory-compact-"));
  try {
    const store = new RuntimeStore(directory, undefined, testSystem);
    const projectRoot = directory;
    // 极低压缩阈值,迫使下一轮触发压缩 → dropped.length > 0 → 重建信封
    const session: Session = {
      ...makeSession("session_c", projectRoot),
      compactThresholdTokens: 500, contextTokens: 2_000
    };
    store.createSession({
      accessMode: "full_access", compactThresholdTokens: 500, contextWindowTokens: 1_000_000,
      model: "deepseek-v4-flash", projectRoot, sessionId: session.sessionId, title: "envelope-compact"
    });
    const baseInput = {
      runId: "run_c1", model: "deepseek-v4-flash", projectRoot, session,
      rules: ruleSource, system: testSystem, tools: toolSpecs
    };

    const turn1 = prepareSessionContext({ ...baseInput, records: [], memoryIndex: store.memoryDigest(projectRoot), prompt: "首轮" });
    store.appendContextEntry(turn1.sessionEnvelopeRecord!);
    const prefixBefore = turn1.telemetry.prefixHash;

    store.saveMemory({ statement: "测试用 npm test", category: "workflow", confidence: 0.8, provenance: "model", visibility: "project", projectRoot });

    // 造足够多的记录让 afterCheckpoint.length > 1 且超过阈值 → 触发压缩
    const seeded: ContextEntry[] = store.readContextEntries(session.sessionId);
    const bulk = Array.from({ length: 6 }, (_, index) => ({
      kind: "human_text" as const, runId: "run_c1", sessionId: session.sessionId, source: "user" as const,
      recordId: `bulk_${index}`, sequence: 100 + index, createdAt: "2026-01-01T00:00:00.000Z",
      text: `历史第 ${index} 条对话内容,占位用,足够长以触发压缩阈值。`.repeat(20)
    }));
    const records = [...seeded, ...bulk];

    const turn2 = prepareSessionContext({ ...baseInput, records, memoryIndex: store.memoryDigest(projectRoot), prompt: "压缩后这一轮" });
    // 压缩发生 → 信封重建 → 新记忆进入当前会话信封(这是冻结的两个解锁条件之一:压缩)
    assert.ok(turn2.compacted && turn2.droppedRecords.length > 0, "应已触发压缩");
    assert.match(memoryIndexOf(turn2), /npm test/, "压缩后重建的信封应含新记忆");
    assert.notEqual(turn2.telemetry.prefixHash, prefixBefore, "压缩后 prefixHash 应改变(信封已重建)");

    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* Windows EPERM */ }
  }
});
