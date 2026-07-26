import {
  estimateProviderRequestTokens,
  BuiltContext,
  ContextConfig,
  defaultContextConfig
} from "./contextBuilder";
import { ContextInput } from "../../shared/contracts/context";
import { RunRegistry } from "./runRegistry";
import { prompts } from "./prompts";
import { Provider, ToolCall } from "../../shared/contracts/provider";
import { EventPayloadMap } from "../../shared/contracts/runtime";
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
import { evaluateCompletion } from "./completionGate";
import { executeToolStep } from "./toolStepExecutor";
import { ModelStepStream } from "./modelStepStream";
import { streamProviderWithRecovery } from "./providerRecovery";
import { persistAssistantRecord, persistPreparedContext, prepareRuntimeContext } from "./runtimeContext";

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
  system: RunRegistry["system"];
  thinkingSummary?: ThinkingSummaryLoop;
};

export type RunInput = Omit<RuntimeInput, "workspaceBaseline" | "capabilities" | "context" | "rules" | "system" | "thinkingSummary"> & Partial<Pick<RuntimeInput, "capabilities" | "context" | "rules">>;

export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

function tryParseArguments(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function openActivity(input: RuntimeInput, data: EventPayloadMap["activity.started"], activityId = input.registry.system.createId("activity")): string {
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
    store: input.store,
    system: input.system
  }, data);
}

function suspendActivity(input: RuntimeInput, activityId: string): void {
  updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, { status: "suspended" });
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
  const pipeline = new ToolPipeline(input.tools, input.rules, input.registry.system, spawnAgentHandler);
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session 不存在。");
  const mode = session.mode === "plan" ? "agent" : classifyInteraction(input.prompt, session);
  const tools = mode === "direct" ? [] : input.tools.specs;
  let prepared = await prepareRuntimeContext(input, session, tools, Boolean(input.continuation));

  const persistContext = (context: BuiltContext) => persistPreparedContext(input, context, {
    onCompactionFinished: (handle, compacted) => finishActivity(input, String(handle), {
      body: `已压缩 ${compacted.compactedRecordCount} 条较早上下文记录。`,
      status: "completed"
    }),
    onCompactionStarted: () => openActivity(input, {
      audience: "user",
      kind: "compaction",
      startedAt: input.registry.system.now()
    })
  });
  persistContext(prepared);
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
        persistContext(refreshed);
        for (const instruction of refreshed.instructions) knownInstructionKeys.add(instruction.instructionKey);
      }
    }
    providerRequestCount += 1;
    let thinkingActivity: string | undefined;
    let answerActivity: string | undefined;
    const modelStepId = input.registry.system.createId("model_step");
    let thinkingSummaryPhaseEnded = false;
    const endThinkingSummaryPhase = () => {
      if (thinkingSummaryPhaseEnded) return;
      thinkingSummaryPhaseEnded = true;
      input.thinkingSummary?.endModelStep();
    };
    const stepStream = new ModelStepStream({
      appendAnswer: (text, firstFragment) => {
        if (firstFragment) {
          answerActivity = openActivity(input, {
            audience: "user",
            body: text,
            kind: "message",
            startedAt: input.registry.system.now()
          });
        } else if (answerActivity) {
          updateActivity({
            activityId: answerActivity,
            runId: input.runId,
            sessionId: input.sessionId,
            store: input.store
          }, { bodyDelta: text });
        }
      },
      appendReasoning: (textDelta) => input.store.append({
        data: { modelStepId, textDelta },
        runId: input.runId,
        sessionId: input.sessionId,
        type: "reasoning.updated"
      }),
      appendThinking: (text) => {
        input.thinkingSummary?.append(text);
        if (!initialThinkingCaptured && !visibleStageStarted) {
          initialThinkingCaptured = true;
          thinkingActivity ??= openActivity(input, {
            audience: "debug",
            kind: "thinking",
            modelStepId,
            startedAt: input.registry.system.now()
          });
        }
      },
      endThinking: endThinkingSummaryPhase,
      startVisibleStage: () => { visibleStageStarted = true; }
    });

    input.store.writeDebugSnapshot(input.sessionId, input.runId, {
      ...prepared.debugSnapshot,
      currentRequestEstimatedTokens: estimateProviderRequestTokens(messages, tools),
      finalMessageRoles: messages.map((message) => message.role),
      providerRequestCount,
      updatedAt: input.registry.system.now()
    });
    const response = await streamProviderWithRecovery({
      onRetry: ({ attempt, maxAttempts }) => input.store.appendContextEntry({
        kind: "runtime_fact",
        metadata: { attempt, transient: true },
        runId: input.runId,
        sessionId: input.sessionId,
        source: "runtime",
        text: `Provider 连接重试 ${attempt}/${maxAttempts}。`
      }),
      provider: input.provider,
      request: {
        maxOutputTokens: prepared.requestedMaxOutputTokens,
        messages,
        model: input.model,
        onFragment: (fragment) => stepStream.push(fragment),
        signal: input.signal,
        tools
      },
      signal: input.signal
    }).finally(() => {
      stepStream.finish();
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
    const completionBlock = response.toolCalls.length === 0
      ? evaluateCompletion({ run: currentRun, runningCommandCount: runningCommandsAtFinal.length })
      : undefined;
    const hasTaskMaintenanceCall = response.toolCalls.some((call) => call.name === "update_tasks");
    if (thinkingActivity) {
      if (response.toolCalls.length > 0) suspendActivity(input, thinkingActivity);
      else finishActivity(input, thinkingActivity, { status: "completed" });
    }
    if (answerActivity) finishActivity(input, answerActivity, {
      audience: completionBlock || hasTaskMaintenanceCall ? "internal" : "user",
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
      if (completionBlock?.kind === "task_maintenance") {
        taskMaintenanceCorrectionCount += 1;
        if (taskMaintenanceCorrectionCount > 2) {
          throw new ModelProtocolError(`模型未能在最终回答前维护任务计划：${completionBlock.issue}。`);
        }
      }
      if (completionBlock) {
        answer = "";
        messages.push({ role: "user", text: completionBlock.retryMessage });
        continue;
      }
      // ADR-008: 不根据正文措辞推断完成，只接受已通过 Runtime 事实门的最终响应。
      // 托管命令与任务维护已在 evaluateCompletion 中检查；finally 仅负责异常路径兜底清理。
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
        store: input.store,
        system: input.system
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
    const toolStep = await executeToolStep({
      calls: response.toolCalls,
      execute: runToolCall,
      parallel: (toolName) => input.tools.parallel(toolName)
    });
    for (const { outcome } of toolStep) {
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
        signal: input.signal,
        system: input.registry.system
      })
    : undefined;
  const normalized: RuntimeInput = {
    ...input,
    capabilities: input.capabilities ?? emptyCapabilitySource,
    context: input.context ?? defaultContextConfig,
    rules: input.rules ?? emptyRuleSource,
    system: input.registry.system,
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
        store: input.store,
        system: normalized.system
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
