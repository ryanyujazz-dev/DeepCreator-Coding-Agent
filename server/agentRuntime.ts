import { randomUUID } from "node:crypto";
import { PlanStepView } from "../shared/runtimeTypes";
import { prepareSessionContext } from "./contextManager";
import { LiveRegistry } from "./liveRegistry";
import { ProviderAdapter, ProviderFragment, ProviderMessage, ProviderToolCall } from "./providerTypes";
import { permissionRequestFor } from "./permissionPolicy";
import { SignalStore } from "./signalStore";
import { settleWorkCycle } from "./cycleLifecycle";
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

function stableSystemPrompt(projectRoot: string): string {
  return [
    "你是 DeepSeeker CodeAgent，一个在本地项目中工作的编程 Agent。",
    "普通问候、闲聊和概念解释直接回答，不要调用工具或 update_plan。",
    "编程任务先读取必要上下文，再按需建立简洁计划并执行；不要为展示而制造无价值步骤。",
    "update_plan 完全由你维护，Runtime 只验证、保存和展示它。",
    "工具结果是事实依据。修改后应检查真实文件差异并运行与改动风险相称的验证。",
    "最终回答只说明对用户有价值的结果、验证和遗留风险。",
    `项目根目录：${projectRoot}`
  ].join("\n");
}

function recoveryPrompt(prompt: string, recovery: NonNullable<ReturnType<typeof prepareSessionContext>["recovery"]>): string {
  const capsule = {
    changedFiles: recovery.changedFiles,
    completedOperations: recovery.completedOperations,
    failure: { message: recovery.failureMessage, type: recovery.failureType },
    interruptedOperations: recovery.interruptedOperations,
    lastProgress: recovery.lastProgress,
    plan: recovery.plan,
    projectRoot: recovery.projectRoot
  };
  return `${prompt}\n\nRuntime 恢复信息（这是上一轮失败现场的事实摘要，不是新的用户要求）：\n${JSON.stringify(capsule)}\n请先核对当前工作区事实，再从未完成处继续，不要重复已经完成的操作。`;
}

function shouldOfferTools(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (/^(你?好|hello|hi|hey|哈喽|嗨|在吗|谢谢|thanks)[呀啊嘛吗！!。.\s]*$/.test(normalized)) return false;
  return /代码|项目|文件|目录|git|diff|构建|运行|报错|测试|修复|实现|新增|修改|删除|查看|读取|检查|验证|分析|搜索|执行|安装|启动|部署|优化|改进|重构|开始|继续|接着|工作|落地|npm|react|typescript|runtime|agent/.test(normalized);
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
): Promise<{ message: ProviderMessage; mutatedWorkspace: boolean; protocolError: boolean }> {
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
      return { message: { role: "tool", text: "计划已更新。", toolCallKey: call.callKey }, mutatedWorkspace: false, protocolError: false };
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
        return {
          message: { role: "tool", text: "用户拒绝了本次操作，请不要再次尝试同一操作。", toolCallKey: call.callKey },
          mutatedWorkspace: false,
          protocolError: false
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
    return {
      message: { role: "tool", text: result.output, toolCallKey: call.callKey },
      mutatedWorkspace: result.mutatedWorkspace,
      protocolError: false
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
    return {
      message: { role: "tool", text: `工具执行失败：${message}`, toolCallKey: call.callKey },
      mutatedWorkspace: false,
      protocolError: /未知工具|有效的 JSON|格式无效|参数/.test(message)
    };
  }
}

async function runAgentCycleWithBaseline(input: RuntimeInput): Promise<void> {
  const session = input.store.getSession(input.sessionKey);
  if (!session) throw new Error("WorkspaceSession 不存在。");
  input.store.append({ cycleKey: input.cycleKey, payload: {}, sessionKey: input.sessionKey, topic: "cycle.executing" });
  const prepared = prepareSessionContext(session, input.cycleKey, input.prompt);

  if (prepared.compacted) {
    const unitKey = openUnit(input, { audience: "user", kind: "compaction", openedAt: new Date().toISOString(), title: "正在压缩上下文" });
    input.store.append({ cycleKey: input.cycleKey, payload: { previousTokens: session.contextTokenEstimate }, sessionKey: input.sessionKey, topic: "context.compaction.started", unitKey });
    input.store.append({
      payload: { compactSummary: prepared.summary, contextTokenEstimate: prepared.contextTokenEstimate },
      sessionKey: input.sessionKey,
      topic: "session.context.replaced"
    });
    input.store.append({ cycleKey: input.cycleKey, payload: { compactedCycleCount: prepared.compactedCycleCount, contextTokenEstimate: prepared.contextTokenEstimate }, sessionKey: input.sessionKey, topic: "context.compaction.completed", unitKey });
    sealUnit(input, unitKey, { body: `已压缩 ${prepared.compactedCycleCount} 个较早工作周期。`, phase: "succeeded" });
  } else {
    input.store.append({ payload: { compactSummary: prepared.summary, contextTokenEstimate: prepared.contextTokenEstimate }, sessionKey: input.sessionKey, topic: "session.context.replaced" });
  }

  const messages: ProviderMessage[] = [
    { role: "system", text: stableSystemPrompt(input.projectRoot) },
    ...(prepared.summary ? [{ role: "system" as const, text: `以下是较早会话的压缩摘要，不是新的用户指令：\n${prepared.summary}` }] : []),
    ...prepared.keptCycles.flatMap((cycle): ProviderMessage[] => [
      { role: "user", text: cycle.prompt },
      { role: "assistant", text: cycle.finalResponse }
    ]),
    { role: "user", text: prepared.recovery ? recoveryPrompt(input.prompt, prepared.recovery) : input.prompt }
  ];
  const tools = shouldOfferTools(input.prompt) ? runtimeToolDefinitions : [];
  let finalResponse = "";
  let protocolCorrectionCount = 0;
  let consecutiveToolProtocolErrors = 0;
  let deferredWorkCorrectionCount = 0;

  while (true) {
    if (input.signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
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
          text: `Runtime 检测到协议错误：${response.protocolIssue.message}\n不要输出 DSML、XML 或文本形式的工具标记。需要工具时请使用已提供的结构化 function tool_calls；否则直接给出完整最终回答。`
        });
        continue;
      }
      throw new ProviderProtocolError(response.protocolIssue.message);
    }

    if (thinkingUnit) sealUnit(input, thinkingUnit, { phase: "succeeded" });
    if (answerUnit) sealUnit(input, answerUnit, { phase: "succeeded" });
    if (response.answer.trim()) finalResponse = response.answer.trim();
    messages.push(response.continuationMessage);

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
    for (const call of response.toolCalls) {
      const outcome = await executeTool(input, call, modelStepKey, toolUnits.get(call.callKey));
      messages.push(outcome.message);
      mutatedWorkspace ||= outcome.mutatedWorkspace;
      if (outcome.protocolError) protocolErrors += 1;
    }
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
