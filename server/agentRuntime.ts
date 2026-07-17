import { randomUUID } from "node:crypto";
import { PlanStepView } from "../shared/runtimeTypes";
import {
  estimateProviderRequestTokens,
  findNewPathInstructions,
  prepareSessionContext,
  renderAdditionalInstructions,
  PreparedContext
} from "./contextManager";
import { ContextRecord } from "./contextRecords";
import { reduceToolEvidence } from "./evidenceReducer";
import { LiveRegistry } from "./liveRegistry";
import { promptBlueprintRegistry } from "./promptBlueprintRegistry";
import { ProviderAdapter, ProviderFragment, ProviderMessage, ProviderToolCall } from "./providerTypes";
import { permissionRequestFor } from "./permissionPolicy";
import { SignalStore } from "./signalStore";
import { settleWorkCycle } from "./cycleLifecycle";
import { classifyInteraction } from "./toolRouting";
import {
  captureWorkspaceBaseline,
  checkpointWorkspaceTarget,
  collectWorkspaceDelta,
  createToolExecutionView,
  executeRuntimeTool,
  activityKindForTool,
  hasRuntimeTool,
  runtimeToolDefinitions,
  runtimeToolNames,
  releaseWorkspaceBaseline,
  summarizeToolArguments,
  summarizeToolResult,
  toolTitle,
  WorkspaceBaseline
} from "./tools";

type RuntimeInput = {
  cycleKey: string;
  sessionKey: string;
  projectRoot: string;
  prompt: string;
  model: string;
  provider: ProviderAdapter;
  registry: LiveRegistry;
  signal?: AbortSignal;
  store: SignalStore;
  workspaceBaseline: WorkspaceBaseline;
};

export type RunAgentCycleInput = Omit<RuntimeInput, "workspaceBaseline">;

export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

function looksLikeDeferredWork(answer: string): boolean {
  return /(?:我(?:将|会|来|先)|接下来|下一步).{0,40}(?:读取|检查|查看|分析|修改|实现|执行|优化|开始|按计划)|(?:先读取|需要了解|以便基于实际代码|再按计划执行)/s.test(answer);
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("工具参数不是有效的 JSON。");
  }
}

function tryParseArguments(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function validatePlan(value: unknown): PlanStepView[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("计划至少需要一个步骤。");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("计划步骤格式无效。");
    const step = raw as Record<string, unknown>;
    const state = String(step.state ?? "pending") as PlanStepView["state"];
    if (!["pending", "in_progress", "completed", "blocked"].includes(state)) throw new Error("计划状态无效。");
    return { label: String(step.label ?? step.stepKey ?? "未命名步骤"), state, stepKey: String(step.stepKey ?? randomUUID()) };
  });
}

function openUnit(input: RuntimeInput, payload: Record<string, unknown>, unitKey = `activity_${randomUUID()}`): string {
  input.store.append({ cycleKey: input.cycleKey, payload, sessionKey: input.sessionKey, topic: "unit.opened", unitKey });
  return unitKey;
}

function sealUnit(input: RuntimeInput, unitKey: string, payload: Record<string, unknown>): void {
  input.store.append({
    cycleKey: input.cycleKey,
    payload: { ...payload, sealedAt: new Date().toISOString() },
    sessionKey: input.sessionKey,
    topic: "unit.sealed",
    unitKey
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
  request: Parameters<ProviderAdapter["stream"]>[0]
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
      const unitKey = openUnit(input, {
        audience: "user",
        body: `Provider 暂时不可用，正在进行第 ${attempt + 1} 次连接。`,
        kind: "error",
        openedAt: new Date().toISOString(),
        title: "正在恢复模型连接"
      });
      sealUnit(input, unitKey, { phase: "succeeded" });
      await waitForRetry(400 * 2 ** (attempt - 1), input.signal);
    }
  }
  throw new Error("Provider recovery exhausted.");
}

async function executeTool(
  input: RuntimeInput,
  call: ProviderToolCall,
  modelStepKey: string,
  existingUnitKey?: string
): Promise<{ message: ProviderMessage; mutatedWorkspace: boolean; protocolError: boolean; target?: string }> {
  let unitKey = existingUnitKey;
  try {
    const args = parseArguments(call.argumentsText);
    if (!hasRuntimeTool(call.name)) throw new Error(`未知工具：${call.name}。可用工具：${runtimeToolNames().join(", ")}`);
    const argumentsSummary = summarizeToolArguments(call.name, args);
    const title = toolTitle(call.name);
    const preparedTool = createToolExecutionView({
      args,
      argumentsPreview: argumentsSummary,
      callKey: call.callKey,
      modelStepKey,
      name: call.name,
      projectRoot: input.projectRoot
    });
    unitKey ??= openUnit(input, {
      audience: "user",
      kind: activityKindForTool(preparedTool),
      openedAt: new Date().toISOString(),
      title,
      tool: preparedTool
    });
    if (existingUnitKey) {
      input.store.append({
        cycleKey: input.cycleKey,
        payload: { kind: activityKindForTool(preparedTool), title, tool: preparedTool },
        sessionKey: input.sessionKey,
        topic: "unit.tool.updated",
        unitKey
      });
    }

    if (call.name === "update_plan") {
      const steps = validatePlan(args.steps);
      input.store.append({ cycleKey: input.cycleKey, payload: { steps }, sessionKey: input.sessionKey, topic: "cycle.plan.replaced" });
      sealUnit(input, unitKey, {
        body: "计划已更新。",
        phase: "succeeded",
        tool: createToolExecutionView({
          args,
          argumentsPreview: argumentsSummary,
          callKey: call.callKey,
          modelStepKey,
          name: call.name,
          output: "计划已更新。",
          projectRoot: input.projectRoot,
          result: { mutatedWorkspace: false, output: "计划已更新。" }
        })
      });
      const text = "计划已更新。";
      input.store.appendContextRecord({
        cycleKey: input.cycleKey,
        kind: "tool_result",
        metadata: { modelStepKey, operationClass: "plan", target: "当前计划" },
        sessionKey: input.sessionKey,
        source: "tool",
        text,
        toolCallKey: call.callKey,
        toolName: call.name
      });
      return { message: { role: "tool", text, toolCallKey: call.callKey }, mutatedWorkspace: false, protocolError: false, target: "当前计划" };
    }

    const session = input.store.getSession(input.sessionKey)!;
    const approval = permissionRequestFor({
      args,
      cycleKey: input.cycleKey,
      grants: session.permissionGrants,
      profile: session.permissionProfile,
      toolName: call.name
    });
    if (approval) {
      const decision = await input.registry.requestApproval({
        ...approval,
        callKey: call.callKey,
        cycleKey: input.cycleKey,
        sessionKey: input.sessionKey,
        signal: input.signal,
        store: input.store,
        toolName: call.name
      });
      if (decision === "deny") {
        sealUnit(input, unitKey, {
          body: "用户拒绝了本次操作。",
          phase: "cancelled",
          tool: { ...preparedTool, resultSummary: "用户拒绝了本次操作。" }
        });
        const text = "用户拒绝了本次操作，请不要再次尝试同一操作。";
        input.store.appendContextRecord({
          cycleKey: input.cycleKey,
          isError: true,
          kind: "tool_result",
          metadata: { modelStepKey, operationClass: preparedTool.operationClass, target: preparedTool.normalizedTarget },
          sessionKey: input.sessionKey,
          source: "tool",
          text,
          toolCallKey: call.callKey,
          toolName: call.name
        });
        return {
          message: { role: "tool", text, toolCallKey: call.callKey },
          mutatedWorkspace: false,
          protocolError: false,
          target: preparedTool.normalizedTarget
        };
      }
    }

    if (call.name === "write_file" || call.name === "edit_file" || call.name === "delete_file") {
      await checkpointWorkspaceTarget(input.projectRoot, input.workspaceBaseline, String(args.path ?? ""));
    }
    const result = await executeRuntimeTool({
      args,
      name: call.name,
      onOutput: call.name === "run_command"
        ? ({ text }) => {
            input.store.append({
              cycleKey: input.cycleKey,
              payload: { text },
              sessionKey: input.sessionKey,
              topic: "unit.commandOutput.appended",
              unitKey: unitKey!
            });
          }
        : undefined,
      projectRoot: input.projectRoot,
      signal: input.signal
    });
    const completedTool = createToolExecutionView({
      args,
      argumentsPreview: argumentsSummary,
      callKey: call.callKey,
      modelStepKey,
      name: call.name,
      output: result.output,
      projectRoot: input.projectRoot,
      result
    });
    sealUnit(input, unitKey, {
      body: summarizeToolResult(call.name, args, result.output),
      command: result.command ? { command: result.command, exitCode: result.exitCode, timedOut: result.timedOut } : undefined,
      phase: result.exitCode && result.exitCode !== 0 ? "failed" : "succeeded",
      tool: completedTool
    });
    const evidence = reduceToolEvidence(call.name, result);
    const recordKey = `context_${randomUUID()}`;
    const artifactRef = input.store.storeContextArtifact(input.sessionKey, recordKey, evidence.fullText);
    input.store.appendContextRecord({
      artifactRef,
      cycleKey: input.cycleKey,
      isError: Boolean(result.exitCode && result.exitCode !== 0),
      kind: "tool_result",
      metadata: {
        digest: evidence.digest,
        modelStepKey,
        operationClass: completedTool.operationClass,
        originalBytes: evidence.originalBytes,
        retainedBytes: evidence.retainedBytes,
        target: completedTool.normalizedTarget
      },
      recordKey,
      sessionKey: input.sessionKey,
      source: "tool",
      text: evidence.modelText,
      toolCallKey: call.callKey,
      toolName: call.name,
      wasTruncated: evidence.wasTruncated
    });
    return {
      message: { role: "tool", text: evidence.modelText, toolCallKey: call.callKey },
      mutatedWorkspace: result.mutatedWorkspace,
      protocolError: false,
      target: completedTool.normalizedTarget
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unitKey ??= openUnit(input, {
      audience: "user",
      body: "",
      kind: "tool",
      openedAt: new Date().toISOString(),
      title: `工具调用失败：${call.name || "未知工具"}`
    });
    sealUnit(input, unitKey, {
      body: message,
      error: message,
      phase: "failed"
    });
    const text = `工具执行失败：${message}`;
    input.store.appendContextRecord({
      cycleKey: input.cycleKey,
      isError: true,
      kind: "tool_result",
      metadata: { modelStepKey, operationClass: "execute", target: call.name || "未知工具" },
      sessionKey: input.sessionKey,
      source: "tool",
      text,
      toolCallKey: call.callKey,
      toolName: call.name
    });
    return {
      message: { role: "tool", text, toolCallKey: call.callKey },
      mutatedWorkspace: false,
      protocolError: /未知工具|有效的 JSON|格式无效|参数/.test(message),
      target: call.name
    };
  }
}

function persistAssistantRecord(input: RuntimeInput, message: ProviderMessage): ContextRecord | undefined {
  if (message.role !== "assistant" || (!message.text && !message.toolCalls?.length)) return undefined;
  return input.store.appendContextRecord({
    cycleKey: input.cycleKey,
    kind: "agent_text",
    reasoningContent: message.toolCalls?.length ? message.continuationThinking : undefined,
    sessionKey: input.sessionKey,
    source: "model",
    text: message.text ?? undefined,
    toolCalls: message.toolCalls
  });
}

function persistPreparedContext(input: RuntimeInput, previousTokens: number, prepared: PreparedContext): void {
  if (prepared.compacted) {
    const unitKey = openUnit(input, { audience: "user", kind: "compaction", openedAt: new Date().toISOString(), title: "正在压缩上下文" });
    input.store.append({ cycleKey: input.cycleKey, payload: { previousTokens }, sessionKey: input.sessionKey, topic: "context.compaction.started", unitKey });
    input.store.appendContextRecord({
      checkpoint: prepared.checkpoint,
      cycleKey: input.cycleKey,
      kind: "checkpoint",
      metadata: { compactedRecordCount: prepared.compactedRecordCount },
      sessionKey: input.sessionKey,
      source: "runtime",
      text: prepared.checkpoint ? JSON.stringify(prepared.checkpoint) : undefined
    });
    input.store.append({
      payload: { compactSummary: prepared.checkpoint ? JSON.stringify(prepared.checkpoint) : undefined, contextTokenEstimate: prepared.contextTokenEstimate },
      sessionKey: input.sessionKey,
      topic: "session.context.replaced"
    });
    input.store.append({ cycleKey: input.cycleKey, payload: { compactedCycleCount: prepared.compactedRecordCount, contextTokenEstimate: prepared.contextTokenEstimate }, sessionKey: input.sessionKey, topic: "context.compaction.completed", unitKey });
    sealUnit(input, unitKey, { body: `已压缩 ${prepared.compactedRecordCount} 条较早上下文记录。`, phase: "succeeded" });
  } else {
    const session = input.store.getSession(input.sessionKey);
    input.store.append({ payload: { compactSummary: session?.compactSummary, contextTokenEstimate: prepared.contextTokenEstimate }, sessionKey: input.sessionKey, topic: "session.context.replaced" });
  }
  input.store.recordContextTelemetry(prepared.telemetry);
  input.store.writeContextDebugSnapshot(input.sessionKey, input.cycleKey, prepared.debugSnapshot);
}

async function runAgentCycleWithBaseline(input: RuntimeInput): Promise<void> {
  const session = input.store.getSession(input.sessionKey);
  if (!session) throw new Error("WorkspaceSession 不存在。");
  input.store.append({ cycleKey: input.cycleKey, payload: {}, sessionKey: input.sessionKey, topic: "cycle.executing" });
  const mode = classifyInteraction(input.prompt, session);
  const tools = mode === "direct" ? [] : runtimeToolDefinitions;
  let prepared = prepareSessionContext({
    currentCycleKey: input.cycleKey,
    model: input.model,
    projectRoot: input.projectRoot,
    prompt: input.prompt,
    providerContextWindowTokens: input.provider.capabilities.contextWindowTokens,
    records: input.store.readContextRecords(input.sessionKey),
    session,
    tools
  });

  persistPreparedContext(input, session.contextTokenEstimate, prepared);
  input.store.appendContextRecord({
    cycleKey: input.cycleKey,
    kind: "human_text",
    sessionKey: input.sessionKey,
    source: "user",
    text: input.prompt
  });
  let messages = [...prepared.messages];
  const knownInstructionKeys = new Set(prepared.instructions.map((instruction) => instruction.instructionKey));
  const activePaths = prepared.retainedRecords
    .map((record) => String(record.metadata?.target ?? ""))
    .filter(Boolean);
  let finalResponse = "";
  let protocolCorrectionCount = 0;
  let consecutiveToolProtocolErrors = 0;
  let deferredWorkCorrectionCount = 0;
  let providerRequestCount = 0;

  while (true) {
    if (input.signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    if (providerRequestCount > 0 && estimateProviderRequestTokens(messages, tools) >= prepared.thresholdTokens) {
      const refreshedSession = input.store.getSession(input.sessionKey)!;
      const refreshed = prepareSessionContext({
        currentCycleKey: input.cycleKey,
        latestUserInRecords: true,
        model: input.model,
        projectRoot: input.projectRoot,
        prompt: input.prompt,
        providerContextWindowTokens: input.provider.capabilities.contextWindowTokens,
        records: input.store.readContextRecords(input.sessionKey),
        session: refreshedSession,
        tools
      });
      if (refreshed.compacted) {
        prepared = refreshed;
        messages = [...refreshed.messages];
        persistPreparedContext(input, refreshedSession.contextTokenEstimate, refreshed);
        for (const instruction of refreshed.instructions) knownInstructionKeys.add(instruction.instructionKey);
      }
    }
    providerRequestCount += 1;
    let thinkingUnit: string | undefined;
    let answerUnit: string | undefined;
    const modelStepKey = `model_step_${randomUUID()}`;
    const toolUnits = new Map<string, string>();
    const toolArgumentBuffers = new Map<string, string>();
    const pendingBuffers = new Map<string, string>();

    const appendBuffered = (unitKey: string, topic: "unit.thinking.appended" | "unit.message.appended", text: string) => {
      const next = (pendingBuffers.get(unitKey) ?? "") + text;
      if (next.length < 48 && !next.includes("\n")) {
        pendingBuffers.set(unitKey, next);
        return;
      }
      pendingBuffers.delete(unitKey);
      input.store.append({ cycleKey: input.cycleKey, payload: { text: next }, sessionKey: input.sessionKey, topic, unitKey });
    };
    const onFragment = (fragment: ProviderFragment) => {
      if (fragment.kind === "thinking") {
        thinkingUnit ??= openUnit(input, { audience: "debug", kind: "thinking", openedAt: new Date().toISOString(), title: "正在思考" });
        appendBuffered(thinkingUnit, "unit.thinking.appended", fragment.text);
      } else if (fragment.kind === "answer") {
        answerUnit ??= openUnit(input, { audience: "user", kind: "message", openedAt: new Date().toISOString(), title: "Agent 回复" });
        appendBuffered(answerUnit, "unit.message.appended", fragment.text);
      } else if (fragment.kind === "tool_call" && fragment.name) {
        const argumentsText = (toolArgumentBuffers.get(fragment.callKey) ?? "") + (fragment.argumentsText ?? "");
        toolArgumentBuffers.set(fragment.callKey, argumentsText);
        const streamedArgs = tryParseArguments(argumentsText);
        const streamedTool = hasRuntimeTool(fragment.name) ? createToolExecutionView({
            args: streamedArgs,
            argumentsPreview: streamedArgs ? summarizeToolArguments(fragment.name, streamedArgs) : "",
            callKey: fragment.callKey,
            modelStepKey,
            name: fragment.name,
            projectRoot: input.projectRoot
          }) : undefined;
        const unitKey = toolUnits.get(fragment.callKey) ?? openUnit(input, streamedTool ? {
          audience: "user",
          kind: activityKindForTool(streamedTool),
          openedAt: new Date().toISOString(),
          title: toolTitle(fragment.name),
          tool: streamedTool
        } : {
          audience: "user",
          kind: "tool",
          openedAt: new Date().toISOString(),
          title: `未知工具：${fragment.name}`
        });
        toolUnits.set(fragment.callKey, unitKey);
        if (streamedArgs && streamedTool) {
          input.store.append({
            cycleKey: input.cycleKey,
            payload: { kind: activityKindForTool(streamedTool), title: toolTitle(fragment.name), tool: streamedTool },
            sessionKey: input.sessionKey,
            topic: "unit.tool.updated",
            unitKey
          });
        }
      }
    };

    input.store.writeContextDebugSnapshot(input.sessionKey, input.cycleKey, {
      ...prepared.debugSnapshot,
      currentRequestEstimatedTokens: estimateProviderRequestTokens(messages, tools),
      finalMessageRoles: messages.map((message) => message.role),
      providerRequestCount,
      updatedAt: new Date().toISOString()
    });
    const response = await streamWithRecovery(input, {
      messages,
      model: input.model,
      onFragment,
      signal: input.signal,
      tools
    });
    for (const [unitKey, text] of pendingBuffers) {
      const unit = input.store.getCycle(input.cycleKey)?.units.find((item) => item.unitKey === unitKey);
      input.store.append({ cycleKey: input.cycleKey, payload: { text }, sessionKey: input.sessionKey, topic: unit?.kind === "thinking" ? "unit.thinking.appended" : "unit.message.appended", unitKey });
    }
    if (response.usage) {
      input.store.append({
        cycleKey: input.cycleKey,
        payload: { ...response.usage, contextTokens: response.usage.inputTokens, source: "provider" },
        sessionKey: input.sessionKey,
        topic: "cycle.usage.replaced"
      });
      input.store.updateContextTelemetryUsage(prepared.telemetry.telemetryKey, {
        actualInputTokens: response.usage.inputTokens,
        cacheHitTokens: response.usage.cacheHitTokens,
        cacheMissTokens: response.usage.cacheMissTokens,
        outputTokens: response.usage.outputTokens
      });
    }

    if (response.protocolIssue) {
      if (thinkingUnit) sealUnit(input, thinkingUnit, { phase: "succeeded" });
      if (answerUnit) sealUnit(input, answerUnit, { audience: "internal", error: response.protocolIssue.message, phase: "failed" });
      for (const unitKey of toolUnits.values()) {
        const unit = input.store.getCycle(input.cycleKey)?.units.find((item) => item.unitKey === unitKey);
        if (unit?.phase === "open") sealUnit(input, unitKey, { body: response.protocolIssue.message, error: response.protocolIssue.message, phase: "failed" });
      }
      messages.push(response.continuationMessage);
      if (response.protocolIssue.retryable && protocolCorrectionCount === 0) {
        protocolCorrectionCount += 1;
        messages.push({
          role: "user",
          text: `${promptBlueprintRegistry.get("protocol_repair", input.model).text}\n错误详情：${response.protocolIssue.message}`
        });
        continue;
      }
      throw new ProviderProtocolError(response.protocolIssue.message);
    }

    if (thinkingUnit) sealUnit(input, thinkingUnit, { phase: "succeeded" });
    if (answerUnit) sealUnit(input, answerUnit, { phase: "succeeded" });
    if (response.answer.trim()) finalResponse = response.answer.trim();
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
      if (tools.length > 0 && deferredWorkCorrectionCount === 0 && looksLikeDeferredWork(finalResponse)) {
        deferredWorkCorrectionCount += 1;
        messages.push({
          role: "user",
          text: "Runtime 检测到你在描述即将执行的工作，但还没有真正调用工具。请现在使用结构化工具读取/检查/修改文件；如果无需工具，请给出已完成的最终结果，不要只写计划。"
        });
        continue;
      }
      input.store.append({
        cycleKey: input.cycleKey,
        payload: await collectWorkspaceDelta(input.projectRoot, input.workspaceBaseline),
        sessionKey: input.sessionKey,
        topic: "cycle.workspaceDelta.replaced"
      });
      settleWorkCycle({
        cycleKey: input.cycleKey,
        finalResponse: finalResponse || "已完成。",
        phase: "succeeded",
        projectRoot: input.projectRoot,
        sessionKey: input.sessionKey,
        store: input.store
      });
      return;
    }
    let mutatedWorkspace = false;
    let protocolErrors = 0;
    const nextPaths: string[] = [];
    for (const call of response.toolCalls) {
      const outcome = await executeTool(input, call, modelStepKey, toolUnits.get(call.callKey));
      messages.push(outcome.message);
      mutatedWorkspace ||= outcome.mutatedWorkspace;
      if (outcome.protocolError) protocolErrors += 1;
      if (outcome.target) nextPaths.push(outcome.target);
    }
    activePaths.push(...nextPaths);
    const additionalInstructions = findNewPathInstructions(input.projectRoot, activePaths, knownInstructionKeys);
    const instructionMessage = renderAdditionalInstructions(additionalInstructions);
    if (instructionMessage) messages.push(instructionMessage);
    for (const instruction of additionalInstructions) knownInstructionKeys.add(instruction.instructionKey);
    if (mutatedWorkspace) {
      input.store.append({
        cycleKey: input.cycleKey,
        payload: await collectWorkspaceDelta(input.projectRoot, input.workspaceBaseline),
        sessionKey: input.sessionKey,
        topic: "cycle.workspaceDelta.replaced"
      });
    }
    consecutiveToolProtocolErrors = protocolErrors === response.toolCalls.length
      ? consecutiveToolProtocolErrors + 1
      : 0;
    if (consecutiveToolProtocolErrors >= 3) {
      throw new ProviderProtocolError("模型连续三次生成未知工具或非法工具参数，已停止本轮以避免无效循环。");
    }
  }
}

export async function runAgentCycle(input: RunAgentCycleInput): Promise<void> {
  const workspaceBaseline = await captureWorkspaceBaseline(input.projectRoot);
  try {
    await runAgentCycleWithBaseline({ ...input, workspaceBaseline });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = input.signal?.aborted ?? false;
    const cycle = input.store.getCycle(input.cycleKey);
    if (cycle && !["succeeded", "failed", "cancelled"].includes(cycle.phase)) {
      input.store.append({
        cycleKey: input.cycleKey,
        payload: await collectWorkspaceDelta(input.projectRoot, workspaceBaseline),
        sessionKey: input.sessionKey,
        topic: "cycle.workspaceDelta.replaced"
      });
      settleWorkCycle({
        cycleKey: input.cycleKey,
        failure: cancelled ? "用户取消了运行。" : message,
        failureType: cancelled ? "cancelled" : error instanceof ProviderProtocolError ? "provider_protocol_error" : "runtime_error",
        finalResponse: cancelled ? "运行已取消。" : "本次运行未能完成。",
        phase: cancelled ? "cancelled" : "failed",
        projectRoot: input.projectRoot,
        sessionKey: input.sessionKey,
        store: input.store
      });
    }
  } finally {
    await releaseWorkspaceBaseline(workspaceBaseline);
  }
}
