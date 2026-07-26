import { randomUUID } from "node:crypto";
import {
  contextUpdateRecord,
  estimateProviderRequestTokens,
  findNewPathInstructions,
  prepareSessionContext,
  BuildInput,
  BuiltContext,
  ContextConfig,
  defaultContextConfig
} from "./contextBuilder";
import { ContextEntry, ContextInput } from "../../shared/contracts/context";
import { RunRegistry } from "./runRegistry";
import { prompts } from "./prompts";
import { Provider, ModelDelta, ModelMessage, ToolCall, ToolSpec } from "../../shared/contracts/provider";
import { EventPayloadMap, Run } from "../../shared/contracts/runtime";
import { Baseline } from "../../shared/contracts/tool";
import { CapabilitySource, emptyCapabilitySource } from "../../shared/contracts/capability";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import {
  ContextPort,
  EventPort,
  EvidencePort,
  MemoryPort,
  MetricPort,
  SessionPort
} from "./runtimeRepo";
import { finishRun } from "./runLifecycle";
import { classifyInteraction } from "./interaction";
import { ToolHost } from "./toolHost";
import { ToolPipeline } from "./toolPipeline";
import { dominantHeadlineKind } from "../../shared/domain/toolActivitySemantics";
import { finishActivity as finishActivityOnce, updateActivity } from "./activityLifecycle";
import { ThinkingSummaryLoop } from "./thinkingSummary";

export type RunnerPorts = ContextPort & EventPort & EvidencePort & MemoryPort & MetricPort & SessionPort;

type RuntimeInput = {
  runId: string;
  sessionId: string;
  projectRoot: string;
  prompt: string;
  model: string;
  capabilities: CapabilitySource;
  context: ContextConfig;
  provider: Provider;
  registry: RunRegistry;
  signal?: AbortSignal;
  store: RunnerPorts;
  tools: ToolHost;
  rules: RuleSource;
  workspaceBaseline: Baseline;
  continuation?: boolean;
  summaryModel?: string;
  thinkingSummary?: ThinkingSummaryLoop;
};

export type RunInput = Omit<RuntimeInput, "workspaceBaseline" | "capabilities" | "context" | "rules" | "thinkingSummary"> & Partial<Pick<RuntimeInput, "capabilities" | "context" | "rules">>;

export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

const TASK_MAINTENANCE_NEUTRAL_TOOLS = new Set(["ask_user", "enter_plan", "submit_plan", "update_tasks"]);

export function finalTaskMaintenanceIssue(run: Run): string | undefined {
  if (run.tasks.length === 0) return undefined;
  const unfinished = run.tasks.filter((task) => task.status === "pending" || task.status === "running");
  if (unfinished.length > 0) {
    return `仍有 ${unfinished.length} 个任务处于 pending 或 running 状态`;
  }
  let lastTaskUpdate = -1;
  let lastWorkTool = -1;
  run.activities.forEach((activity, index) => {
    const toolName = activity.tool?.toolName;
    if (!toolName) return;
    if (toolName === "update_tasks" && activity.status === "completed") lastTaskUpdate = index;
    else if (!TASK_MAINTENANCE_NEUTRAL_TOOLS.has(toolName)) lastWorkTool = index;
  });
  if (lastTaskUpdate < lastWorkTool) {
    return "最后一次 update_tasks 早于最后一次工作工具调用";
  }
  if (lastTaskUpdate < 0) return "任务清单尚未通过 update_tasks 完成最终维护";
  return undefined;
}

function tryParseArguments(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function openActivity(input: RuntimeInput, data: EventPayloadMap["activity.started"], activityId = `activity_${randomUUID()}`): string {
  input.store.append({ runId: input.runId, data, sessionId: input.sessionId, type: "activity.started", activityId });
  return activityId;
}

function finishActivity(
  input: RuntimeInput,
  activityId: string,
  data: Omit<EventPayloadMap["activity.finished"], "finishedAt">
): boolean {
  return finishActivityOnce({
    activityId,
    runId: input.runId,
    sessionId: input.sessionId,
    store: input.store
  }, data);
}

function suspendActivity(input: RuntimeInput, activityId: string): void {
  updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, { status: "suspended" });
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("运行已取消。", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function streamWithRecovery(
  input: RuntimeInput,
  request: Parameters<Provider["stream"]>[0]
) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let receivedFragment = false;
    try {
      return await input.provider.stream({
        ...request,
        onFragment: (fragment) => {
          receivedFragment = true;
          request.onFragment?.(fragment);
        }
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /\b429\b|\b5\d\d\b|fetch failed|network|socket|timeout/i.test(message);
      if (!transient || receivedFragment || attempt === maxAttempts) throw error;
      input.store.appendContextEntry({
        kind: "runtime_fact",
        metadata: { attempt: attempt + 1, transient: true },
        runId: input.runId,
        sessionId: input.sessionId,
        source: "runtime",
        text: `Provider 连接重试 ${attempt + 1}/${maxAttempts}。`
      });
      await waitForRetry(400 * 2 ** (attempt - 1), input.signal);
    }
  }
  throw new Error("Provider 重试已耗尽。");
}

function persistAssistantRecord(input: RuntimeInput, message: ModelMessage): ContextEntry | undefined {
  if (message.role !== "assistant" || (!message.text && !message.toolCalls?.length)) return undefined;
  return input.store.appendContextEntry({
    runId: input.runId,
    kind: "agent_text",
    reasoningContent: message.toolCalls?.length ? message.continuationThinking : undefined,
    sessionId: input.sessionId,
    source: "model",
    text: message.text ?? undefined,
    toolCalls: message.toolCalls
  });
}

function persistPreparedContext(input: RuntimeInput, previousTokens: number, prepared: BuiltContext): void {
  if (prepared.sessionEnvelopeRecord) input.store.appendContextEntry(prepared.sessionEnvelopeRecord);
  if (prepared.recoveryRecord && !input.store.readContextEntries(input.sessionId).some((record) =>
    record.kind === "recovery_capsule" && record.runId === input.runId
  )) input.store.appendContextEntry(prepared.recoveryRecord);
  if (prepared.compacted) {
    const activityId = openActivity(input, { audience: "user", kind: "compaction", startedAt: new Date().toISOString() });
    input.store.appendContextEntry({
      checkpoint: prepared.checkpoint,
      runId: input.runId,
      kind: "checkpoint",
      metadata: { compactedRecordCount: prepared.compactedRecordCount },
      sessionId: input.sessionId,
      source: "runtime",
      text: prepared.checkpoint ? JSON.stringify(prepared.checkpoint) : undefined
    });
    input.store.append({
      data: { compactSummary: prepared.checkpoint ? JSON.stringify(prepared.checkpoint) : undefined, contextTokens: prepared.contextTokens },
      sessionId: input.sessionId,
      type: "session.updated"
    });
    finishActivity(input, activityId, { body: `已压缩 ${prepared.compactedRecordCount} 条较早上下文记录。`, status: "completed" });
  } else {
    const session = input.store.getSession(input.sessionId);
    input.store.append({ data: { compactSummary: session?.compactSummary, contextTokens: prepared.contextTokens }, sessionId: input.sessionId, type: "session.updated" });
  }
  input.store.recordMetric(prepared.telemetry);
  input.store.writeDebugSnapshot(input.sessionId, input.runId, prepared.debugSnapshot);
}

function semanticTranscript(records: ContextEntry[], maxChars: number): string {
  const text = records
    .filter((record) => record.kind === "human_text" || record.kind === "agent_text")
    .map((record) => `${record.kind === "human_text" ? "USER" : "ASSISTANT"}: ${record.text ?? ""}`)
    .join("\n\n");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[Runtime 已省略较早的对话]\n\n${text.slice(-tail)}`;
}

async function prepareRuntimeContext(
  input: RuntimeInput,
  session: NonNullable<ReturnType<SessionPort["getSession"]>>,
  tools: ToolSpec[],
  latestUserInRecords = false
): Promise<BuiltContext> {
  const contextInput: BuildInput = {
    capabilityIndex: input.capabilities.digest(input.projectRoot),
    context: input.context,
    runId: input.runId,
    latestUserInRecords,
    memoryIndex: input.store.memoryDigest(input.projectRoot),
    model: input.model,
    projectRoot: input.projectRoot,
    prompt: input.prompt,
    providerContextWindowTokens: input.provider.capabilities.contextWindowTokens,
    records: input.store.readContextEntries(input.sessionId),
    rules: input.rules,
    session,
    tokenCalibrationFactor: input.store.readCalibration(input.model),
    tools
  };
  const prepared = prepareSessionContext(contextInput);
  if (!prepared.compacted || prepared.droppedRecords.length === 0 || !input.provider.summarizeContext) return prepared;
  try {
    const semanticSummary = await input.provider.summarizeContext({
      model: input.model,
      signal: input.signal,
      transcript: semanticTranscript(prepared.droppedRecords, input.context.maxSummaryChars)
    });
    return prepareSessionContext({ ...contextInput, semanticSummary });
  } catch {
    // Deterministic checkpoint facts remain sufficient when semantic compression is unavailable.
    return prepared;
  }
}

async function executeRun(input: RuntimeInput): Promise<void> {
  // spawn_agent handler:携带 provider/registry/store 等运行时依赖注入到 pipeline。
  // 子 Agent 在独立 Session 上运行,复用 runAgent,只返回最终摘要。
  const spawnAgentHandler = async (args: { description: string; prompt: string; subagentType: "Explore" | "general-purpose" }) => {
    const { spawnSubAgent } = await import("./subAgent");
    return spawnSubAgent({
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagentType,
      parentRunId: input.runId,
      parentSessionId: input.sessionId,
      projectRoot: input.projectRoot,
      model: input.model,
      store: input.store,
      tools: input.tools,
      provider: input.provider,
      registry: input.registry,
      rules: input.rules,
      capabilities: input.capabilities,
      context: input.context,
      signal: input.signal
    });
  };
  const pipeline = new ToolPipeline(input.tools, input.rules, spawnAgentHandler);
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session 不存在。");
  const mode = session.mode === "plan" ? "agent" : classifyInteraction(input.prompt, session);
  const tools = mode === "direct" ? [] : input.tools.specs;
  let prepared = await prepareRuntimeContext(input, session, tools, Boolean(input.continuation));

  persistPreparedContext(input, session.contextTokens, prepared);
  if (!input.continuation) {
    input.store.appendContextEntry({
      runId: input.runId,
      kind: "human_text",
      sessionId: input.sessionId,
      source: "user",
      text: input.prompt
    });
  }
  let messages = [...prepared.messages];
  const knownInstructionKeys = new Set([
    ...prepared.instructions.map((instruction) => instruction.instructionKey),
    ...input.store.readContextEntries(input.sessionId).flatMap((record) =>
      Array.isArray(record.metadata?.guidanceKeys) ? record.metadata.guidanceKeys.map(String) : []
    )
  ]);
  let answer = "";
  let protocolCorrectionCount = 0;
  let taskMaintenanceCorrectionCount = 0;
  let consecutiveToolProtocolErrors = 0;
  let providerRequestCount = 0;
  let initialThinkingCaptured = input.store.getRun(input.runId)?.activities
    .some((activity) => activity.kind === "thinking") ?? false;
  let visibleStageStarted = input.store.getRun(input.runId)?.activities
    .some((activity) => activity.kind === "message" || Boolean(activity.tool)) ?? false;

  while (true) {
    if (input.signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    if (providerRequestCount > 0 && estimateProviderRequestTokens(messages, tools) >= prepared.thresholdTokens) {
      const refreshedSession = input.store.getSession(input.sessionId)!;
      const refreshed = await prepareRuntimeContext(input, refreshedSession, tools, true);
      if (refreshed.compacted) {
        prepared = refreshed;
        messages = [...refreshed.messages];
        persistPreparedContext(input, refreshedSession.contextTokens, refreshed);
        for (const instruction of refreshed.instructions) knownInstructionKeys.add(instruction.instructionKey);
      }
    }
    providerRequestCount += 1;
    let thinkingActivity: string | undefined;
    let answerActivity: string | undefined;
    const modelStepId = `model_step_${randomUUID()}`;
    let reasoningBuffer = "";
    let reasoningBufferTimer: ReturnType<typeof setTimeout> | undefined;
    let thinkingSummaryPhaseEnded = false;
    const endThinkingSummaryPhase = () => {
      if (thinkingSummaryPhaseEnded) return;
      thinkingSummaryPhaseEnded = true;
      input.thinkingSummary?.endModelStep();
    };
    const flushReasoning = () => {
      if (reasoningBufferTimer) clearTimeout(reasoningBufferTimer);
      reasoningBufferTimer = undefined;
      if (!reasoningBuffer) return;
      const textDelta = reasoningBuffer;
      reasoningBuffer = "";
      input.store.append({
        data: { modelStepId, textDelta },
        runId: input.runId,
        sessionId: input.sessionId,
        type: "reasoning.updated"
      });
    };
    const appendReasoning = (text: string) => {
      if (!text) return;
      reasoningBuffer += text;
      if (reasoningBuffer.length >= 48 || reasoningBuffer.includes("\n")) {
        flushReasoning();
        return;
      }
      reasoningBufferTimer ??= setTimeout(flushReasoning, 40);
    };
    const pendingBuffers = new Map<string, string>();
    const pendingBufferTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const flushBuffered = (activityId: string) => {
      const timer = pendingBufferTimers.get(activityId);
      if (timer) clearTimeout(timer);
      pendingBufferTimers.delete(activityId);
      const text = pendingBuffers.get(activityId);
      pendingBuffers.delete(activityId);
      if (text) updateActivity({
        activityId,
        runId: input.runId,
        sessionId: input.sessionId,
        store: input.store
      }, { bodyDelta: text });
    };
    const flushPendingBuffers = () => {
      for (const activityId of pendingBuffers.keys()) flushBuffered(activityId);
    };
    const appendBuffered = (activityId: string, text: string) => {
      const next = (pendingBuffers.get(activityId) ?? "") + text;
      if (next.length < 48 && !next.includes("\n")) {
        pendingBuffers.set(activityId, next);
        if (!pendingBufferTimers.has(activityId)) {
          pendingBufferTimers.set(activityId, setTimeout(() => flushBuffered(activityId), 40));
        }
        return;
      }
      pendingBuffers.set(activityId, next);
      flushBuffered(activityId);
    };
    const onFragment = (fragment: ModelDelta) => {
      if (fragment.kind === "thinking") {
        input.thinkingSummary?.append(fragment.text);
        appendReasoning(fragment.text);
        if (!initialThinkingCaptured && !visibleStageStarted) {
          initialThinkingCaptured = true;
          thinkingActivity ??= openActivity(input, {
            audience: "debug",
            kind: "thinking",
            modelStepId,
            startedAt: new Date().toISOString()
          });
        }
      } else if (fragment.kind === "answer") {
        endThinkingSummaryPhase();
        visibleStageStarted = true;
        flushReasoning();
        if (!answerActivity) {
          answerActivity = openActivity(input, {
            audience: "user",
            body: fragment.text,
            kind: "message",
            startedAt: new Date().toISOString()
          });
        } else {
          appendBuffered(answerActivity, fragment.text);
        }
      } else if (fragment.kind === "tool_call") {
        endThinkingSummaryPhase();
        visibleStageStarted = true;
        flushReasoning();
        flushPendingBuffers();
      }
    };

    input.store.writeDebugSnapshot(input.sessionId, input.runId, {
      ...prepared.debugSnapshot,
      currentRequestEstimatedTokens: estimateProviderRequestTokens(messages, tools),
      finalMessageRoles: messages.map((message) => message.role),
      providerRequestCount,
      updatedAt: new Date().toISOString()
    });
    const response = await streamWithRecovery(input, {
      maxOutputTokens: prepared.requestedMaxOutputTokens,
      messages,
      model: input.model,
      onFragment,
      signal: input.signal,
      tools
    }).finally(() => {
      endThinkingSummaryPhase();
      flushReasoning();
      flushPendingBuffers();
    });
    if (response.usage) {
      input.store.append({
        runId: input.runId,
        data: { ...response.usage, contextTokens: response.usage.inputTokens, source: "provider" },
        sessionId: input.sessionId,
        type: "usage.changed"
      });
      input.store.updateMetricUsage(prepared.telemetry.metricId, {
        actualInputTokens: response.usage.inputTokens,
        cacheHitTokens: response.usage.cacheHitTokens,
        cacheMissTokens: response.usage.cacheMissTokens,
        outputTokens: response.usage.outputTokens
      });
    }

    if (response.protocolIssue) {
      if (thinkingActivity) finishActivity(input, thinkingActivity, { status: "completed" });
      if (answerActivity) finishActivity(input, answerActivity, { audience: "internal", error: response.protocolIssue.message, status: "failed" });
      messages.push(response.continuationMessage);
      if (response.protocolIssue.retryable && protocolCorrectionCount === 0) {
        protocolCorrectionCount += 1;
        messages.push({
          role: "user",
          text: `${prompts.get("protocol_repair", input.model).text}\n错误详情：${response.protocolIssue.message}`
        });
        continue;
      }
      throw new ModelProtocolError(response.protocolIssue.message);
    }

    const runningCommandsAtFinal = response.toolCalls.length === 0
      ? input.tools.runningCommands(input.runId)
      : [];
    const currentRun = response.toolCalls.length === 0
      ? input.store.getRun(input.runId)
      : undefined;
    const taskMaintenanceIssue = currentRun
      ? finalTaskMaintenanceIssue(currentRun)
      : undefined;
    const hasTaskMaintenanceCall = response.toolCalls.some((call) => call.name === "update_tasks");
    if (thinkingActivity) {
      if (response.toolCalls.length > 0) suspendActivity(input, thinkingActivity);
      else finishActivity(input, thinkingActivity, { status: "completed" });
    }
    if (answerActivity) finishActivity(input, answerActivity, {
      audience: runningCommandsAtFinal.length > 0 || taskMaintenanceIssue || hasTaskMaintenanceCall ? "internal" : "user",
      status: "completed"
    });
    if (response.answer.trim()) answer = response.answer.trim();
    messages.push(response.continuationMessage);
    persistAssistantRecord(input, response.continuationMessage);
    if (response.finishCause === "length" || response.finishCause === "content_filter" || response.finishCause === "insufficient_system_resource") {
      throw new Error(response.finishCause === "length"
        ? "模型输出达到长度限制，未形成完整回答。"
        : response.finishCause === "content_filter"
          ? "模型输出被内容策略中止。"
          : "DeepSeek 推理资源不足，本轮未完成。");
    }
    if (response.toolCalls.length === 0) {
      if (runningCommandsAtFinal.length > 0) {
        answer = "";
        messages.push({
          role: "user",
          text: `当前文本不能作为最终回答，因为仍有 ${runningCommandsAtFinal.length} 个托管命令正在运行。请调用 wait_command 等待，或调用 stop_command 结束命令；所有命令进入终态后才能给出最终回答。`
        });
        continue;
      }
      if (taskMaintenanceIssue) {
        taskMaintenanceCorrectionCount += 1;
        if (taskMaintenanceCorrectionCount > 2) {
          throw new ModelProtocolError(`模型未能在最终回答前维护任务计划：${taskMaintenanceIssue}。`);
        }
        answer = "";
        messages.push({
          role: "user",
          text: `当前文本不能作为最终回答，因为任务计划尚未完成收尾：${taskMaintenanceIssue}。不要继续输出最终回答；请先在一个独立步骤中调用 update_tasks，提交完整且真实的任务列表，将已完成事项标记为 completed、受阻事项标记为 blocked，并确保没有 pending 或 running。收到工具结果后的下一轮再生成最终回答。`
        });
        continue;
      }
      // ADR-008: 信任模型——不调工具即视为完成。
      // 对标 ZCode/Codex/Claude Code:三家都不在代码层检测"延迟工作"或强制重试。
      // 纪律由提示词层保证(doing_tasks/final_response slot),不由代码层强制。
      // 唯一例外:如果有托管命令仍在运行,runAgent 的 finally 块会统一停止它们。
      input.store.append({
        runId: input.runId,
        data: await input.tools.changes(input.projectRoot, input.workspaceBaseline),
        sessionId: input.sessionId,
        type: "changes.changed"
      });
      await input.thinkingSummary?.finish();
      finishRun({
        runId: input.runId,
        answer: answer || "已完成。",
        status: "completed",
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        store: input.store
      });
      return;
    }
    let protocolErrors = 0;
    const deferredContextRecords: ContextInput[] = [];
    const deferredEvidenceRecords: ContextInput[] = [];
    const stepRejection = pipeline.stepRejection(response.toolCalls, modelStepId, input.projectRoot);
    const stepHeadline = dominantHeadlineKind(response.toolCalls.flatMap((call) => {
      try {
        if (!input.tools.has(call.name)) return [];
        const args = tryParseArguments(call.argumentsText);
        if (!args) return [];
        return [input.tools.prepare({
          args,
          argumentsPreview: input.tools.summarizeArgs(call.name, args),
          callId: call.callId,
          modelStepId,
          name: call.name,
          projectRoot: input.projectRoot
        })];
      } catch {
        return [];
      }
    }));
    let suspended = false;
    const runToolCall = (call: ToolCall) => pipeline.run({
        baseline: input.workspaceBaseline,
        projectRoot: input.projectRoot,
        registry: input.registry,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        store: input.store
      }, call, modelStepId, knownInstructionKeys, undefined, stepRejection, stepHeadline);
    const outcomes = new Map<string, Awaited<ReturnType<typeof runToolCall>>>();
    let parallelBatch: ToolCall[] = [];
    const flushParallel = async () => {
      if (parallelBatch.length === 0) return;
      const batch = parallelBatch;
      parallelBatch = [];
      const batchOutcomes = await Promise.all(batch.map(runToolCall));
      batch.forEach((call, index) => outcomes.set(call.callId, batchOutcomes[index]));
    };
    for (const call of response.toolCalls) {
      if (input.tools.parallel(call.name)) {
        parallelBatch.push(call);
        continue;
      }
      await flushParallel();
      outcomes.set(call.callId, await runToolCall(call));
    }
    await flushParallel();
    for (const call of [...response.toolCalls].sort((left, right) => left.index - right.index)) {
      const outcome = outcomes.get(call.callId)!;
      if (outcome.message) messages.push(outcome.message);
      deferredEvidenceRecords.push(...(outcome.evidenceRecords ?? []));
      deferredContextRecords.push(...outcome.contextRecords);
      suspended ||= Boolean(outcome.suspended);
      if (outcome.protocolError) protocolErrors += 1;
    }
    for (const record of deferredEvidenceRecords) input.store.appendContextEntry(record);
    for (const record of deferredContextRecords) {
      const persisted = input.store.appendContextEntry(record);
      messages.push({ role: "user", text: persisted.text ?? "" });
    }
    if (suspended) {
      await input.thinkingSummary?.finish();
      return;
    }
    consecutiveToolProtocolErrors = protocolErrors === response.toolCalls.length
      ? consecutiveToolProtocolErrors + 1
      : 0;
    if (consecutiveToolProtocolErrors >= 3) {
      throw new ModelProtocolError("模型连续三次生成未知工具或非法工具参数，已停止本轮以避免无效循环。");
    }
  }
}

export async function runAgent(input: RunInput): Promise<void> {
  const thinkingSummary = input.summaryModel
    ? new ThinkingSummaryLoop({
        initialThinking: input.store.getRun(input.runId)?.reasoningSteps?.at(-1)?.text,
        initialTitle: input.store.getRun(input.runId)?.reasoningTitle,
        model: input.summaryModel,
        onTitle: (title) => {
          const run = input.store.getRun(input.runId);
          if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;
          input.store.append({
            data: { title },
            runId: input.runId,
            sessionId: input.sessionId,
            type: "reasoning.title.updated"
          });
        },
        provider: input.provider,
        signal: input.signal
      })
    : undefined;
  const normalized: RuntimeInput = {
    ...input,
    capabilities: input.capabilities ?? emptyCapabilitySource,
    context: input.context ?? defaultContextConfig,
    rules: input.rules ?? emptyRuleSource,
    thinkingSummary,
    workspaceBaseline: await input.tools.capture(input.projectRoot)
  };
  const workspaceBaseline = normalized.workspaceBaseline;
  try {
    await executeRun(normalized);
  } catch (error) {
    thinkingSummary?.cancel();
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = input.signal?.aborted ?? false;
    const run = input.store.getRun(input.runId);
    if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
      input.store.append({
        runId: input.runId,
        data: await input.tools.changes(input.projectRoot, workspaceBaseline),
        sessionId: input.sessionId,
        type: "changes.changed"
      });
      finishRun({
        runId: input.runId,
        error: cancelled ? "用户取消了运行。" : message,
        failureType: cancelled ? "cancelled" : error instanceof ModelProtocolError ? "provider_protocol_error" : "runtime_error",
        answer: cancelled ? "运行已取消。" : "本次运行未能完成。",
        status: cancelled ? "cancelled" : "failed",
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        store: input.store
      });
    }
  } finally {
    thinkingSummary?.cancel();
    await input.tools.stopCommands(input.runId);
    await input.tools.close(workspaceBaseline);
  }
}

export class Runner {
  constructor(
    private readonly tools: ToolHost,
    private readonly rules: RuleSource = emptyRuleSource,
    private readonly capabilities: CapabilitySource = emptyCapabilitySource,
    private readonly context: ContextConfig = defaultContextConfig
  ) {}

  run(input: Omit<RunInput, "tools">): Promise<void> {
    return runAgent({ ...input, capabilities: this.capabilities, context: this.context, rules: this.rules, tools: this.tools });
  }
}
