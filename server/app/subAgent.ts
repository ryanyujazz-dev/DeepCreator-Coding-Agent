import { runAgent, RunInput } from "./runner";
import { ToolHost } from "./toolHost";
import { RunRegistry } from "./runRegistry";
import { Provider } from "../../shared/contracts/provider";
import { CapabilitySource, emptyCapabilitySource } from "../../shared/contracts/capability";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import { defaultContextConfig, ContextConfig } from "./contextBuilder";
import { ToolResult } from "../../shared/contracts/tool";

// ─────────────────────────────────────────────────────────────────────────────
// 子 Agent(spawn_agent)实现。
//
// 架构决策:
//   同一 Session 不允许并发 Run。因此 spawn_agent 创建独立的子 Session,
//   在子 Session 上复用 runAgent,只返回最终摘要。
//   子 Agent 的中间 Event 不写入父 Session,避免上下文污染。
//
// 工具白名单:
//   "Explore" 类型:仅只读工具(read_file/grep/glob/list_files/git_status/search_memory)
//   "general-purpose" 类型:全工具集(排除 spawn_agent 本身,防递归)
//
// 递归保护:
//   spawn_agent 工具本身永远不在白名单中,因此子 Agent 无法再 spawn 孙 Agent。
// ─────────────────────────────────────────────────────────────────────────────

/** Explore 子 Agent 可用的只读工具集。 */
const EXPLORE_TOOLS = new Set([
  "read_file", "grep", "glob", "list_files", "git_status", "search_memory", "search_capabilities"
]);

/** general-purpose 子 Agent 可用的工具集(排除 spawn_agent 防递归)。 */
const GENERAL_PURPOSE_BLOCKED = new Set(["spawn_agent"]);

/**
 * 创建一个受限的 ToolHost 包装器,只允许白名单内的工具执行。
 * 策略:白名单外的工具调用直接返回错误信息,不抛异常(让子 Agent 能继续工作)。
 */
function createRestrictedToolHost(
  delegate: ToolHost,
  allowedTools: Set<string>
): ToolHost {
  const filteredSpecs = delegate.specs.filter((spec) => allowedTools.has(spec.name));
  return {
    capture: (projectRoot) => delegate.capture(projectRoot),
    changes: (projectRoot, baseline) => delegate.changes(projectRoot, baseline),
    checkpoint: (projectRoot, baseline, target) => delegate.checkpoint(projectRoot, baseline, target),
    close: (baseline) => delegate.close(baseline),
    execute: async (input) => {
      if (!allowedTools.has(input.name)) {
        return {
          mutatedWorkspace: false,
          output: `工具 ${input.name} 在此子 Agent 类型中不可用。可用的工具:${[...allowedTools].join(", ")}`
        } satisfies ToolResult;
      }
      return delegate.execute(input);
    },
    has: (name) => allowedTools.has(name) && delegate.has(name),
    kind: (tool) => delegate.kind(tool),
    names: () => delegate.names().filter((name) => allowedTools.has(name)),
    parallel: (name) => allowedTools.has(name) && delegate.parallel(name),
    prepare: (input) => delegate.prepare(input),
    retain: (baseline) => delegate.retain(baseline),
    runningCommands: (runId) => delegate.runningCommands(runId),
    specs: filteredSpecs,
    stopCommands: (runId) => delegate.stopCommands(runId),
    summarizeArgs: (name, args) => delegate.summarizeArgs(name, args),
    summarizeResult: (name, args, output) => delegate.summarizeResult(name, args, output),
    title: (name) => delegate.title(name)
  };
}

export interface SpawnAgentInput {
  description: string;
  prompt: string;
  subagentType: "Explore" | "general-purpose";
  parentRunId: string;
  parentSessionId: string;
  projectRoot: string;
  model: string;
  store: RunInput["store"];
  tools: ToolHost;
  provider: Provider;
  registry: RunRegistry;
  rules?: RuleSource;
  capabilities?: CapabilitySource;
  context?: ContextConfig;
  signal?: AbortSignal;
}

/**
 * 启动一个隔离子 Agent,执行给定 prompt,返回最终摘要。
 *
 * 流程:
 *   1. 创建子 Session(继承父 Session 的上下文窗口配置)
 *   2. 根据类型构建工具白名单 → 受限 ToolHost
 *   3. 调 runAgent 在子 Session 上执行
 *   4. 提取子 Session 最后一条 assistant 消息作为摘要
 *   5. 返回摘要字符串(作为父 Run 的 ToolResult.output)
 */
export async function spawnSubAgent(input: SpawnAgentInput): Promise<string> {
  const allowedTools = input.subagentType === "Explore"
    ? EXPLORE_TOOLS
    : new Set(input.tools.names().filter((name) => !GENERAL_PURPOSE_BLOCKED.has(name)));
  const restrictedTools = createRestrictedToolHost(input.tools, allowedTools);

  // 继承父 Session 的上下文窗口配置
  const parentSession = input.store.getSession(input.parentSessionId);
  const childSessionId = input.registry.system.createId("session_sub");
  const childRunId = input.registry.system.createId("run_sub");
  input.store.createSession({
    accessMode: "request_approval",
    compactThresholdTokens: parentSession?.compactThresholdTokens ?? 850_000,
    contextWindowTokens: parentSession?.contextWindowTokens ?? 1_000_000,
    model: input.model,
    projectRoot: input.projectRoot,
    sessionId: childSessionId,
    title: `子 Agent: ${input.description.slice(0, 60)}`
  });
  input.store.append({
    data: { model: input.model, prompt: input.prompt, startedAt: input.registry.system.now() },
    runId: childRunId,
    sessionId: childSessionId,
    type: "run.started"
  });
  const childController = input.registry.startRun(childRunId);
  const abortChild = () => childController.abort(input.signal?.reason);
  if (input.signal?.aborted) abortChild();
  else input.signal?.addEventListener("abort", abortChild, { once: true });

  // 启动子 Run(continuation=true 跳过 plan-mode 交互入口)
  try {
    await runAgent({
      runId: childRunId,
      sessionId: childSessionId,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      model: input.model,
      capabilities: input.capabilities ?? emptyCapabilitySource,
      context: input.context ?? defaultContextConfig,
      provider: input.provider,
      registry: input.registry,
      rules: input.rules ?? emptyRuleSource,
      store: input.store,
      tools: restrictedTools,
      signal: childController.signal,
      continuation: true
    });
  } catch (error) {
    // 子 Agent 失败不崩溃父 Run,返回错误摘要
    const message = error instanceof Error ? error.message : String(error);
    return `子 Agent 执行失败:${message}`;
  } finally {
    input.signal?.removeEventListener("abort", abortChild);
    input.registry.finishRun(childRunId);
  }

  // 提取子 Session 的最终 assistant 回答
  return extractFinalAnswer(input.store, childSessionId, childRunId, input.description);
}

/**
 * 从子 Session 的上下文记录中提取最后一条 agent_text 作为摘要。
 */
function extractFinalAnswer(
  store: SpawnAgentInput["store"],
  sessionId: string,
  runId: string,
  description: string
): string {
  const records = store.readContextEntries(sessionId);
  const agentTexts = records.filter(
    (record) => record.runId === runId && record.kind === "agent_text" && record.text && !record.toolCalls?.length
  );
  const lastText = agentTexts.at(-1)?.text?.trim();
  if (lastText) return lastText;

  const lastAgentMessage = records.filter(
    (record) => record.runId === runId && record.kind === "agent_text" && record.text
  ).at(-1)?.text?.trim();
  if (lastAgentMessage) return lastAgentMessage;

  return `子 Agent "${description}" 完成执行,但未返回可读摘要。请查看子 Session ${sessionId} 的活动记录。`;
}
