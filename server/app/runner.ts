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
import { Baseline } from "../../shared/contracts/tool";
import { CapabilitySource, emptyCapabilitySource } from "../../shared/contracts/capability";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import { RuntimeRepo } from "./runtimeRepo";
import { finishRun } from "./runLifecycle";
import { classifyInteraction, requiresWorkspaceAction } from "./interaction";
import { ToolHost } from "./toolHost";
import { ToolPipeline } from "./toolPipeline";
import { PlanArgumentStream } from "./planStream";
import { MutationArgumentStream } from "./mutationStream";

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
  store: RuntimeRepo;
  tools: ToolHost;
  rules: RuleSource;
  workspaceBaseline: Baseline;
  continuation?: boolean;
};

export type RunInput = Omit<RuntimeInput, "workspaceBaseline" | "capabilities" | "context" | "rules"> & Partial<Pick<RuntimeInput, "capabilities" | "context" | "rules">>;

export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

function looksLikeDeferredWork(answer: string): boolean {
  return /(?:我(?:将|会|来|先)|接下来|下一步).{0,40}(?:读取|检查|查看|分析|修改|实现|执行|优化|开始|按计划)|(?:先读取|需要了解|以便基于实际代码|再按计划执行)/s.test(answer);
}

function tryParseArguments(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function openActivity(input: RuntimeInput, data: Record<string, unknown>, activityId = `activity_${randomUUID()}`): string {
  input.store.append({ runId: input.runId, data, sessionId: input.sessionId, type: "activity.started", activityId });
  return activityId;
}

function finishActivity(input: RuntimeInput, activityId: string, data: Record<string, unknown>): void {
  input.store.append({
    runId: input.runId,
    data: { liveFiles: [], ...data, finishedAt: new Date().toISOString() },
    sessionId: input.sessionId,
    type: "activity.finished",
    activityId
  });
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
      const activityId = openActivity(input, {
        audience: "user",
        body: `Provider 暂时不可用，正在进行第 ${attempt + 1} 次连接。`,
        kind: "error",
        startedAt: new Date().toISOString(),
        title: "正在恢复模型连接"
      });
      finishActivity(input, activityId, { status: "completed" });
      await waitForRetry(400 * 2 ** (attempt - 1), input.signal);
    }
  }
  throw new Error("Provider recovery exhausted.");
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
    const activityId = openActivity(input, { audience: "user", kind: "compaction", startedAt: new Date().toISOString(), title: "正在压缩上下文" });
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
  return `${text.slice(0, head)}\n\n[older dialogue omitted by Runtime]\n\n${text.slice(-tail)}`;
}

async function prepareRuntimeContext(
  input: RuntimeInput,
  session: NonNullable<ReturnType<RuntimeRepo["getSession"]>>,
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
  const pipeline = new ToolPipeline(input.tools, input.rules);
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
  let consecutiveToolProtocolErrors = 0;
  let deferredWorkCorrectionCount = 0;
  let unfinishedCommandCorrectionCount = 0;
  let providerRequestCount = 0;

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
    const toolActivities = new Map<string, string>();
    const toolArgumentBuffers = new Map<string, string>();
    const planArgumentStreams = new Map<string, PlanArgumentStream>();
    const mutationArgumentStreams = new Map<string, MutationArgumentStream>();
    const pendingBuffers = new Map<string, string>();

    const appendBuffered = (activityId: string, text: string) => {
      const next = (pendingBuffers.get(activityId) ?? "") + text;
      if (next.length < 48 && !next.includes("\n")) {
        pendingBuffers.set(activityId, next);
        return;
      }
      pendingBuffers.delete(activityId);
      input.store.append({ runId: input.runId, data: { bodyDelta: next }, sessionId: input.sessionId, type: "activity.updated", activityId });
    };
    const onFragment = (fragment: ModelDelta) => {
      if (fragment.kind === "thinking") {
        thinkingActivity ??= openActivity(input, {
          audience: "debug",
          kind: "thinking",
          modelStepId,
          startedAt: new Date().toISOString(),
          title: ""
        });
      } else if (fragment.kind === "answer") {
        if (!answerActivity) {
          answerActivity = openActivity(input, {
            audience: "user",
            body: fragment.text,
            kind: "message",
            startedAt: new Date().toISOString(),
            title: "Agent 回复"
          });
        } else {
          appendBuffered(answerActivity, fragment.text);
        }
      } else if (fragment.kind === "tool_call" && fragment.name) {
        if (fragment.name === "wait_command" || fragment.name === "stop_command") return;
        const argumentsText = (toolArgumentBuffers.get(fragment.callId) ?? "") + (fragment.argumentsText ?? "");
        toolArgumentBuffers.set(fragment.callId, argumentsText);
        const streamedArgs = tryParseArguments(argumentsText);
        const streamedTool = input.tools.has(fragment.name) ? input.tools.prepare({
            args: streamedArgs ?? {},
            argumentsPreview: streamedArgs ? input.tools.summarizeArgs(fragment.name, streamedArgs) : "",
            callId: fragment.callId,
            modelStepId,
            name: fragment.name,
            projectRoot: input.projectRoot
          }) : undefined;
        const activityId = toolActivities.get(fragment.callId) ?? openActivity(input, streamedTool ? {
          audience: "user",
          kind: input.tools.kind(streamedTool),
          modelStepId,
          startedAt: new Date().toISOString(),
          title: fragment.name === "submit_plan" ? "正在编写计划" : input.tools.title(fragment.name),
          tool: streamedTool
        } : {
          audience: "user",
          kind: "tool",
          modelStepId,
          startedAt: new Date().toISOString(),
          title: `未知工具：${fragment.name}`
        });
        toolActivities.set(fragment.callId, activityId);
        if (fragment.name === "write_file" || fragment.name === "edit_file") {
          const mutationStream = mutationArgumentStreams.get(fragment.callId) ?? new MutationArgumentStream(fragment.name);
          mutationArgumentStreams.set(fragment.callId, mutationStream);
          const liveFile = mutationStream.push(fragment.argumentsText ?? "");
          if (liveFile) {
            input.store.append({
              activityId,
              data: { liveFiles: [liveFile] },
              runId: input.runId,
              sessionId: input.sessionId,
              type: "activity.updated"
            });
          }
        }
        if (fragment.name === "submit_plan") {
          const planStream = planArgumentStreams.get(fragment.callId) ?? new PlanArgumentStream();
          planArgumentStreams.set(fragment.callId, planStream);
          const update = planStream.push(fragment.argumentsText ?? "");
          if (update.title !== undefined) {
            input.store.append({
              activityId,
              data: { title: update.title || "正在编写计划" },
              runId: input.runId,
              sessionId: input.sessionId,
              type: "activity.updated"
            });
          }
          if (update.markdownDelta) appendBuffered(activityId, update.markdownDelta);
        }
        if (streamedArgs && streamedTool) {
          input.store.append({
            runId: input.runId,
            data: {
              kind: input.tools.kind(streamedTool),
              title: fragment.name === "submit_plan"
                ? String(streamedArgs.title ?? "正在编写计划")
                : input.tools.title(fragment.name),
              tool: streamedTool
            },
            sessionId: input.sessionId,
            type: "activity.updated",
            activityId
          });
        }
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
    });
    for (const [callId, mutationStream] of mutationArgumentStreams) {
      const liveFile = mutationStream.flush();
      const activityId = toolActivities.get(callId);
      if (activityId && liveFile) {
        input.store.append({
          activityId,
          data: { liveFiles: [liveFile] },
          runId: input.runId,
          sessionId: input.sessionId,
          type: "activity.updated"
        });
      }
    }
    for (const [activityId, text] of pendingBuffers) {
      const activity = input.store.getRun(input.runId)?.activities.find((item) => item.activityId === activityId);
      if (activity?.kind !== "thinking") {
        input.store.append({ runId: input.runId, data: { bodyDelta: text }, sessionId: input.sessionId, type: "activity.updated", activityId });
      }
    }
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
      for (const activityId of toolActivities.values()) {
        const activity = input.store.getRun(input.runId)?.activities.find((item) => item.activityId === activityId);
        if (activity?.status === "running") finishActivity(input, activityId, activity.kind === "plan"
          ? { error: response.protocolIssue.message, status: "failed" }
          : { body: response.protocolIssue.message, error: response.protocolIssue.message, status: "failed" });
      }
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

    if (thinkingActivity) finishActivity(input, thinkingActivity, { status: "completed" });
    if (answerActivity) finishActivity(input, answerActivity, { status: "completed" });
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
      const runningCommandIds = new Set([
        ...input.tools.runningCommands(input.runId).map((command) => command.commandId),
        ...(input.store.getRun(input.runId)?.activities ?? [])
          .filter((activity) => activity.status === "running" && Boolean(activity.command?.commandId))
          .map((activity) => activity.command!.commandId!)
      ]);
      if (runningCommandIds.size > 0) {
        unfinishedCommandCorrectionCount += 1;
        if (unfinishedCommandCorrectionCount >= 3) {
          throw new ModelProtocolError("模型连续三次尝试在命令仍运行时结束本轮。Runtime 已停止本次运行的命令。");
        }
        messages.push({
          role: "user",
          text: `Runtime 检测到仍在运行或正在收尾的命令：${[...runningCommandIds].join(", ")}。当前文本不能作为最终回答；请调用 wait_command 继续等待，或在不再需要命令时调用 stop_command。不要重复启动同一命令。`
        });
        continue;
      }
      const currentMode = input.store.getSession(input.sessionId)?.mode ?? session.mode;
      if (currentMode === "plan") {
        messages.push({
          role: "user",
          text: "当前处于计划模式。普通文本不能结束本轮：若信息不足，请调用 ask_user；若方案已经完整，请调用 submit_plan 提交可审阅方案。不要执行任何实现操作。"
        });
        continue;
      }
      if (
        tools.length > 0 &&
        deferredWorkCorrectionCount === 0 &&
        (looksLikeDeferredWork(answer) || requiresWorkspaceAction(input.prompt))
      ) {
        deferredWorkCorrectionCount += 1;
        messages.push({
          role: "user",
          text: "Runtime 检测到这是需要在工作区执行的任务，但当前回答没有任何工具证据。请现在使用结构化工具读取、检查或修改真实文件；不得把计划、代码示例或准备执行的描述当作已完成结果。"
        });
        continue;
      }
      input.store.append({
        runId: input.runId,
        data: await input.tools.changes(input.projectRoot, input.workspaceBaseline),
        sessionId: input.sessionId,
        type: "changes.changed"
      });
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
    let suspended = false;
    const runToolCall = (call: ToolCall) => pipeline.run({
        baseline: input.workspaceBaseline,
        projectRoot: input.projectRoot,
        registry: input.registry,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        store: input.store
      }, call, modelStepId, knownInstructionKeys, toolActivities.get(call.callId), stepRejection);
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
    if (suspended) return;
    consecutiveToolProtocolErrors = protocolErrors === response.toolCalls.length
      ? consecutiveToolProtocolErrors + 1
      : 0;
    if (consecutiveToolProtocolErrors >= 3) {
      throw new ModelProtocolError("模型连续三次生成未知工具或非法工具参数，已停止本轮以避免无效循环。");
    }
  }
}

export async function runAgent(input: RunInput): Promise<void> {
  const normalized: RuntimeInput = {
    ...input,
    capabilities: input.capabilities ?? emptyCapabilitySource,
    context: input.context ?? defaultContextConfig,
    rules: input.rules ?? emptyRuleSource,
    workspaceBaseline: await input.tools.capture(input.projectRoot)
  };
  const workspaceBaseline = normalized.workspaceBaseline;
  try {
    await executeRun(normalized);
  } catch (error) {
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
