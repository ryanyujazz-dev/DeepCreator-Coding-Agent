import {
  estimateProviderRequestTokens,
  BuiltContext,
  ContextConfig,
  defaultContextConfig
} from "./contextBuilder";
import { ContextInput } from "../../shared/contracts/context";
import { RunRegistry } from "./runRegistry";
import { prompts } from "./prompts";
import { ModelProtocol, ModelResponse, Provider, ToolCall } from "../../shared/contracts/provider";
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
import { appendInterruptedToolResults, finishRun } from "./runLifecycle";
import { missingToolResults } from "../../shared/domain/toolProtocol";
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
import { AgentId } from "../../shared/contracts/runtime";
import { DelegationCoordinator } from "./delegationCoordinator";
import { agentDefinition, createAgentToolHost } from "./agentDefinitions";

export type RunnerPorts = ContextPort & EventPort & EvidencePort & MemoryPort & MetricPort & SessionPort;

type RuntimeInput = {
  agentPrompt?: string;
  runId: string;
  sessionId: string;
  projectRoot: string;
  prompt: string;
  model: string;
  protocol: ModelProtocol;
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
  /** 命令长挂起多久后提醒模型可 stop_command(默认 120s;测试注入小值)。 */
  settledWaitPromptMs?: number;
  summaryModel?: string;
  system: RunRegistry["system"];
  thinkingSummary?: ThinkingSummaryLoop;
  delegations?: DelegationCoordinator;
};

export type RunInput = Omit<RuntimeInput, "workspaceBaseline" | "capabilities" | "context" | "rules" | "system" | "thinkingSummary" | "protocol">
  & Partial<Pick<RuntimeInput, "capabilities" | "context" | "rules" | "protocol">>;

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
  // delegate 只创建独立子运行；终态结果由 DelegationCoordinator 以类型化消息回注。
  const delegateHandler = input.delegations ? (args: { activityId: string; agent: AgentId; callId: string; message: string }) => input.delegations!.delegate({
    ...args,
    model: input.model,
    parentRunId: input.runId,
    parentSessionId: input.sessionId,
    projectRoot: input.projectRoot
  }) : undefined;
  const pipeline = new ToolPipeline(input.tools, input.rules, input.registry.system, delegateHandler);
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session 不存在。");
  const mode = session.kind === "subagent" || session.mode === "plan" ? "agent" : classifyInteraction(input.prompt, session);
  const tools = mode === "direct" ? [] : input.tools.specs;
  const promptAlreadyPersisted = input.store.readContextEntries(input.sessionId).some((record) =>
    record.runId === input.runId && record.kind === "human_text" && record.text === input.prompt
  );
  let prepared = await prepareRuntimeContext(input, session, tools, Boolean(input.continuation) || promptAlreadyPersisted);

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
  if (!input.continuation && !promptAlreadyPersisted) {
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
  let protocolCorrectionCount = 0;
  let taskMaintenanceCorrectionCount = 0;
  let consecutiveToolProtocolErrors = 0;
  let providerRequestCount = 0;
  let initialThinkingCaptured = input.store.getRun(input.runId)?.activities
    .some((activity) => activity.kind === "thinking") ?? false;
  let visibleStageStarted = input.store.getRun(input.runId)?.activities
    .some((activity) => activity.kind === "message" || Boolean(activity.tool)) ?? false;
  const applyPendingSteers = () => {
    const steers = input.registry.takeSteers(input.runId);
    for (const steer of steers) {
      const record = input.store.readContextEntries(input.sessionId).find((entry) =>
        entry.runId === input.runId && entry.kind === "human_text" && entry.metadata?.steerId === steer.steerId
      ) ?? input.store.appendContextEntry({
          kind: "human_text",
          metadata: { steerId: steer.steerId },
          runId: input.runId,
          sessionId: input.sessionId,
          source: "user",
          text: steer.prompt
        });
      messages.push({ role: "user", text: record.text ?? steer.prompt });
    }
    return steers.length > 0;
  };
  const applyDelegationResults = () => {
    const results = input.delegations?.takeResults(input.runId) ?? [];
    messages.push(...results);
    return results.length > 0;
  };
  // harness 回调(批次 3.1b):后台命令自然结束后把最终输出作为续写消息注入。
  // 输出按 head/tail 裁剪到与 evidence 证据上限同量级——与 toolPipeline
  // settleManagedCommand 持久化 context_update 的 modelText(14000 上限)同形,
  // 崩溃续跑重放时模型看到一致的消息形态。
  const SETTLED_OUTPUT_MAX_CHARS = 14_000;
  // 命令长时间不结束时的周期提醒:模型挂起等待期间无法自发行动,超时后提示
  // 一次可调 stop_command 结束命令(run 完成门要求全部命令终态)。
  const settledWaitPromptMs = input.settledWaitPromptMs ?? 120_000;
  let settledWaitingSince: number | undefined;
  const settledCommandMessage = (settled: { command: string; commandId: string; exitCode?: number; output: string; state: string }) => {
    const output = settled.output.length <= SETTLED_OUTPUT_MAX_CHARS
      ? settled.output
      : `${settled.output.slice(0, Math.floor(SETTLED_OUTPUT_MAX_CHARS * 0.68))}\n\n[...中间内容已由 Runtime 裁剪...]\n\n${settled.output.slice(-Math.floor(SETTLED_OUTPUT_MAX_CHARS * 0.32))}`;
    return `命令 ${settled.commandId} 已结束。状态：${settled.state}，退出码：${settled.exitCode ?? "未知"}。\n${output}`;
  };
  const applySettledCommandResults = () => {
    const settled = input.tools.takeSettledCommands?.(input.runId) ?? [];
    for (const snapshot of settled) {
      messages.push({ role: "user", text: settledCommandMessage(snapshot) });
    }
    return settled.length > 0;
  };
  // 恢复(continuation/断线续接)时丢弃上一轮循环遗留的内存快照:该轮挂起期间
  // 被 finally 取消的命令已由 settleManagedCommand 持久化 context_update,
  // prepareRuntimeContext 会重放——这里再注入就是同一信息投递两次。
  if (input.continuation) input.tools.takeSettledCommands?.(input.runId);

  while (true) {
    if (input.signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    applyPendingSteers();
    applyDelegationResults();
    // settle 结果在 provider 调用前注入(与 delegation 结果同位),本轮请求即带上,
    // 避免先空转一轮 provider 再注入的浪费。
    applySettledCommandResults();
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
    const providerActivitiesByItemId = new Map<string, string>();
    const providerActivitiesByCallId = new Map<string, string>();
    const providerActivitiesByIndex = new Map<number, string>();
    const previousArgumentsByItemId = new Map<string, string>();
    const applyPatchIndices = new Set<number>();
    const pendingArgsByKey = new Map<string, { activityId: string; text: string }>();
    let argsTimer: ReturnType<typeof setTimeout> | undefined;
    let thinkingSummaryPhaseEnded = false;
    const endThinkingSummaryPhase = () => {
      if (thinkingSummaryPhaseEnded) return;
      thinkingSummaryPhaseEnded = true;
      input.thinkingSummary?.endModelStep();
    };
    const finishThinkingActivity = (status: "cancelled" | "completed" = "completed") => {
      if (!thinkingActivity) return;
      const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === thinkingActivity);
      if (!current || (current.status !== "running" && current.status !== "suspended")) return;
      finishActivity(input, thinkingActivity, { status });
    };
    const stepStream = new ModelStepStream({
      appendAnswer: (text, firstFragment, source) => {
        if (firstFragment) {
          answerActivity = openActivity(input, {
            audience: "user",
            body: text,
            kind: "message",
            modelItemId: source?.itemId,
            modelStepId,
            startedAt: input.registry.system.now()
          });
          if (source?.itemId) providerActivitiesByItemId.set(source.itemId, answerActivity);
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

    // argumentsDelta 批处理(48 字/40ms,与 modelStepStream reasoning flush 一致):避免每 token
    // sessions.save(O(session-size):JSON.stringify 全 session + searchText + UPSERT)。
    const ARGS_FLUSH_CHARS = 48;
    const ARGS_FLUSH_DELAY_MS = 40;
    const flushPendingArgs = () => {
      if (argsTimer) { clearTimeout(argsTimer); argsTimer = undefined; }
      for (const [, entry] of pendingArgsByKey) {
        if (!entry.text) continue;
        updateActivity({ activityId: entry.activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, { argumentsDelta: entry.text });
      }
      pendingArgsByKey.clear();
    };
    const bufferArgsDelta = (key: string, activityId: string | undefined, delta: string) => {
      if (!delta || !activityId) return;
      const existing = pendingArgsByKey.get(key);
      if (existing) existing.text += delta;
      else pendingArgsByKey.set(key, { activityId, text: delta });
      if ((pendingArgsByKey.get(key)?.text.length ?? 0) >= ARGS_FLUSH_CHARS) {
        flushPendingArgs();
        return;
      }
      argsTimer ??= setTimeout(flushPendingArgs, ARGS_FLUSH_DELAY_MS);
    };

    const openToolActivityOnName = (params: { callId: string; index: number; itemId?: string; name: string }): string | undefined => {
      if (params.name === "stop_command") return undefined;
      if (!input.tools.has(params.name)) return undefined;
      const outline = input.tools.outline(params.name);
      const activityId = openActivity(input, {
        audience: "user",
        kind: "tool",
        modelItemId: params.itemId,
        modelStepId,
        phase: "generating_args",
        startedAt: input.registry.system.now(),
        tool: {
          callId: params.callId,
          callIndex: params.index,
          modelStepId,
          toolName: params.name,
          argumentsPreview: "",
          normalizedTarget: "",
          ...outline
        }
      });
      providerActivitiesByCallId.set(params.callId, activityId);
      providerActivitiesByIndex.set(params.index, activityId);
      if (params.itemId) providerActivitiesByItemId.set(params.itemId, activityId);
      if (params.name === "apply_patch") applyPatchIndices.add(params.index);
      return activityId;
    };

    const handleOutputItem = (item: Omit<import("../../shared/contracts/provider").ModelOutputItem, "modelStepId">) => {
      const durableItem = { ...item, modelStepId };
      input.store.append({
        data: { item: durableItem },
        runId: input.runId,
        sessionId: input.sessionId,
        type: "model.output_item.changed"
      });
      if (item.type === "reasoning") {
        if (item.status === "completed" || item.status === "failed") {
          endThinkingSummaryPhase();
          finishThinkingActivity(item.status === "failed" ? "cancelled" : "completed");
        }
        return;
      }
      if (item.type === "message") {
        // content item 完成(response.output_item.done for message)时立即 flush answer buffer 尾端。
        // 根治 responses 协议 content 卡尾:content 最后 < ANSWER_FLUSH_CHARS 字进 answer buffer 走 16ms 定时器,
        // 而紧随的 tool_call 参数流式(response.function_call_arguments.delta)只 update output_item、不发
        // fragment、不触发 stepStream.flush,占用 event loop 把 16ms 定时器饿死 → content 尾端被挤到 tool_call
        // 完成(response.output_item.done for function → tool_call fragment → flush)后才 flush,即「content 先出
        // 大半,工具一执行,结尾几个字才蹦出来」。content item done 在 tool_call args 之前(stream 顺序:
        // text deltas → message item done → tool args deltas → tool item done),此处同步 flush 把尾端立即放出。
        if (item.status === "completed") stepStream.flush();
        const activityId = providerActivitiesByItemId.get(item.itemId) ?? answerActivity;
        if (activityId && item.citations) {
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, { citations: item.citations });
        }
        return;
      }
      if (item.type === "hosted_tool" && item.toolName === "web_search") {
        visibleStageStarted = true;
        let activityId = providerActivitiesByItemId.get(item.itemId);
        const tool = {
          action: "search" as const,
          argumentsPreview: item.searchQuery ? JSON.stringify({ query: item.searchQuery }) : "",
          callId: item.callId ?? item.itemId,
          callIndex: item.outputIndex,
          effect: "external_side_effect" as const,
          modelStepId,
          normalizedTarget: item.searchQuery ?? "网络",
          targetKind: "network" as const,
          toolName: "web_search"
        };
        if (!activityId) {
          activityId = openActivity(input, {
            audience: "user",
            body: item.searchQuery ?? "",
            kind: "tool",
            modelItemId: item.itemId,
            modelStepId,
            startedAt: input.registry.system.now(),
            title: item.searchStatus === "searching" ? "搜索中" : "准备搜索",
            tool
          });
          providerActivitiesByItemId.set(item.itemId, activityId);
        } else {
          const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
          if (current && current.status !== "running" && current.status !== "suspended") return;
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            title: item.searchStatus === "searching" ? "搜索中" : item.searchStatus === "completed" ? "搜索完成" : "准备搜索",
            tool
          });
        }
        if (item.status === "completed" || item.status === "failed") {
          finishActivity(input, activityId, {
            body: item.searchQuery ? `搜索 ${item.searchQuery}` : "搜索网络",
            error: item.error,
            status: item.status === "failed" ? "failed" : "completed",
            tool: { ...tool, resultMetrics: { itemCount: 1 }, resultSummary: item.searchQuery ? `搜索 ${item.searchQuery}` : "搜索网络" }
          });
        }
        return;
      }
      if (item.type === "custom" && item.toolName === "apply_patch") {
        visibleStageStarted = true;
        let activityId = providerActivitiesByItemId.get(item.itemId);
        const callId = item.callId ?? item.itemId;
        const tool = {
          action: "modify" as const,
          argumentsPreview: "补丁草稿（未应用）",
          callId,
          callIndex: item.outputIndex,
          effect: "workspace_write" as const,
          modelStepId,
          normalizedTarget: "工作区补丁",
          targetKind: "workspace" as const,
          toolName: "apply_patch"
        };
        if (!activityId) {
          activityId = openActivity(input, {
            audience: "user",
            body: "",
            draft: { kind: "apply_patch", state: "generating", text: item.draft ?? "" },
            kind: "tool",
            modelItemId: item.itemId,
            modelStepId,
            startedAt: input.registry.system.now(),
            title: "正在生成补丁",
            tool
          });
          providerActivitiesByItemId.set(item.itemId, activityId);
          providerActivitiesByCallId.set(callId, activityId);
        } else {
          const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
          if (current && current.status !== "running" && current.status !== "suspended") return;
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            draft: { kind: "apply_patch", state: item.status === "completed" ? "unapplied" : "generating", text: item.draft ?? "" },
            status: item.status === "completed" ? "suspended" : "running",
            title: item.status === "completed" ? "补丁草稿待应用" : "正在生成补丁"
          });
        }
      }
      if (item.type === "function" && item.callId && item.toolName) {
        // responses 普通工具:name 识别时预开(phase generating_args),arguments delta 实时流到 activity(展开可见)。
        // phase 翻 executing 统一在 toolPipeline 复用分支(不在流内)。
        visibleStageStarted = true;
        const callId = item.callId;
        let activityId = providerActivitiesByItemId.get(item.itemId) ?? providerActivitiesByCallId.get(callId);
        if (!activityId) {
          activityId = openToolActivityOnName({ callId, index: item.outputIndex, itemId: item.itemId, name: item.toolName });
        }
        if (activityId) {
          const prev = previousArgumentsByItemId.get(item.itemId) ?? "";
          const current = item.argumentsText ?? "";
          if (current.length > prev.length) {
            bufferArgsDelta(`item:${item.itemId}`, activityId, current.slice(prev.length));
          }
          previousArgumentsByItemId.set(item.itemId, current);
        }
        return;
      }
    };

    const handleToolCallFragment = (fragment: { callId: string; index: number; name?: string; argumentsText?: string }) => {
      // chat 协议:name 到达时预开(phase generating_args),argumentsText 是 delta 原文直接 emit。
      const index = fragment.index;
      if (fragment.name) {
        if (!providerActivitiesByIndex.has(index)) {
          openToolActivityOnName({ callId: fragment.callId, index, name: fragment.name });
        } else {
          const existing = providerActivitiesByIndex.get(index)!;
          // chat callId 不稳定(pending_N → 真 id):把 byCallId 旧 key 迁移到真 id
          for (const [key, value] of providerActivitiesByCallId) {
            if (value === existing && key !== fragment.callId) providerActivitiesByCallId.delete(key);
          }
          providerActivitiesByCallId.set(fragment.callId, existing);
        }
      }
      const activityId = providerActivitiesByIndex.get(index);
      if (!activityId || !fragment.argumentsText) return;
      // apply_patch(chat)不发 args —— 内容是 JSON-wrapped patch,执行时 toolPipeline 抽 draft,避免重复流。
      // 用 applyPatchIndices O(1) 判断(预开时记),避免每 fragment getRun 全 session 扫 + structuredClone。
      if (applyPatchIndices.has(index)) return;
      bufferArgsDelta(`idx:${index}`, activityId, fragment.argumentsText);
    };

    input.store.writeDebugSnapshot(input.sessionId, input.runId, {
      ...prepared.debugSnapshot,
      currentRequestEstimatedTokens: estimateProviderRequestTokens(messages, tools),
      finalMessageRoles: messages.map((message) => message.role),
      providerRequestCount,
      updatedAt: input.registry.system.now()
    });
    const providerStep = input.registry.beginInterruptibleStep(input.runId);
    let response: ModelResponse;
    try {
      response = await streamProviderWithRecovery({
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
          modelStepId,
          onFragment: (fragment) => {
            if (fragment.kind === "output_item") handleOutputItem(fragment.item);
            else {
              if (fragment.kind === "tool_call") handleToolCallFragment(fragment);
              stepStream.push(fragment);
            }
          },
          protocol: input.protocol,
          signal: providerStep.signal,
          tools
        },
        signal: providerStep.signal
      });
    } catch (error) {
      if (!input.signal?.aborted && providerStep.interruptedBySteer() && input.registry.hasSteers(input.runId)) {
        finishThinkingActivity("cancelled");
        if (answerActivity) finishActivity(input, answerActivity, { status: "cancelled" });
        applyPendingSteers();
        continue;
      }
      const orphanActivityIds = new Set<string>([
        ...providerActivitiesByItemId.values(),
        ...providerActivitiesByCallId.values(),
        ...providerActivitiesByIndex.values()
      ]);
      for (const activityId of orphanActivityIds) {
        const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
        if (!current || (current.status !== "running" && current.status !== "suspended") || current.kind === "message") continue;
        const message = error instanceof Error ? error.message : String(error);
        finishActivity(input, activityId, {
          draft: current.draft ? { ...current.draft, state: "failed" } : undefined,
          error: message,
          status: "failed",
          tool: current.tool
        });
      }
      throw error;
    } finally {
      flushPendingArgs();
      stepStream.finish();
      providerStep.release();
    }
    if (!input.signal?.aborted && providerStep.interruptedBySteer() && input.registry.hasSteers(input.runId)) {
      finishThinkingActivity("cancelled");
      if (answerActivity) finishActivity(input, answerActivity, { status: "cancelled" });
      applyPendingSteers();
      continue;
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
      finishThinkingActivity();
      if (answerActivity) finishActivity(input, answerActivity, { error: response.protocolIssue.message, status: "failed" });
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

    // completionGate 只剩任务维护门;后台命令由下方 harness 回调(harness 回调注入)接管。
    const currentRun = response.toolCalls.length === 0
      ? input.store.getRun(input.runId)
      : undefined;
    const completionBlock = response.toolCalls.length === 0
      ? evaluateCompletion({ run: currentRun })
      : undefined;
    if (thinkingActivity) {
      const currentThinking = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === thinkingActivity);
      if (currentThinking?.status === "running" || currentThinking?.status === "suspended") {
        if (response.toolCalls.length > 0) suspendActivity(input, thinkingActivity);
        else finishActivity(input, thinkingActivity, { status: "completed" });
      }
    }
    if (answerActivity) finishActivity(input, answerActivity, {
      status: "completed"
    });
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
      if (applyDelegationResults()) {
        continue;
      }
      if ((input.delegations?.activeCount(input.runId) ?? 0) > 0) {
        await input.delegations!.waitForResult(input.runId, input.signal);
        applyDelegationResults();
        continue;
      }
      // harness 回调:有未终态后台命令 → 挂起等 settle(周期醒 30s)。
      // 内部等待循环:只有真正有事(命令全部终态 / settle 注入 / 用户 steer /
      // 长挂起提醒)才 break 回 provider,避免每 30s 用不变上下文空转一轮。
      if (input.tools.runningCommands(input.runId).length > 0) {
        settledWaitingSince ??= input.registry.system.nowMs();
        while (true) {
          await input.tools.waitForSettled(input.runId, input.signal, 30_000);
          if (applyPendingSteers()) break; // 用户 steer → 唤醒模型
          if (input.tools.runningCommands(input.runId).length === 0) {
            settledWaitingSince = undefined;
            break; // 全部终态 → 循环顶注入 settle 结果
          }
          if (input.registry.system.nowMs() - settledWaitingSince >= settledWaitPromptMs) {
            settledWaitingSince = input.registry.system.nowMs(); // 重置,下一周期才再提醒
            messages.push({ role: "user", text: "仍有后台命令在运行，Run 在全部命令进入终态前无法结束。若命令输出已满足需要，请调用 stop_command 结束它；否则继续等待。" });
            break; // 提醒 → 唤醒模型决策(等/停)
          }
          // 无事发生 → 继续挂起,不打扰模型
        }
        continue;
      }
      settledWaitingSince = undefined;
      if (completionBlock) {
        taskMaintenanceCorrectionCount += 1;
        if (taskMaintenanceCorrectionCount > 2) {
          throw new ModelProtocolError(`模型未能在最终回答前维护任务计划：${completionBlock.issue}。`);
        }
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
      if (applyPendingSteers()) {
        continue;
      }
      await input.thinkingSummary?.finish();
      if (applyPendingSteers()) {
        continue;
      }
      if (applyDelegationResults()) {
        continue;
      }
      if ((input.delegations?.activeCount(input.runId) ?? 0) > 0) {
        await input.delegations!.waitForResult(input.runId, input.signal);
        applyDelegationResults();
        continue;
      }
      // finishRun 前兜底:命令在模型流式输出期间 settle(未走 no-tool_calls 分支)
      // 或取消 settle 落入 newlySettled → 注入后回到循环顶重新收尾判断。
      if (applySettledCommandResults()) {
        continue;
      }
      finishRun({
        runId: input.runId,
        // The model owns its content. Preserve the terminal payload byte-for-byte,
        // including whitespace and the empty string; status and errors are separate facts.
        answer: response.answer,
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
    const toolControl = input.registry.beginInterruptibleStep(input.runId);
    const runToolCall = (call: ToolCall) => {
      const existingActivityId = providerActivitiesByCallId.get(call.callId);
      return pipeline.run({
        baseline: input.workspaceBaseline,
        projectRoot: input.projectRoot,
        registry: input.registry,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: toolControl.signal,
        store: input.store
      }, call, modelStepId, knownInstructionKeys, existingActivityId, stepRejection, stepHeadline);
    };
    let toolStep: Awaited<ReturnType<typeof executeToolStep>>;
    flushPendingArgs();
    try {
      toolStep = await executeToolStep({
        calls: response.toolCalls,
        execute: runToolCall,
        parallel: (toolName) => input.tools.parallel(toolName)
      });
    } catch (error) {
      if (!input.signal?.aborted && toolControl.interruptedBySteer() && input.registry.hasSteers(input.runId)) {
        const interruptionReason = "用户发送了新的引导，当前工具步骤已中断";
        const missing = missingToolResults(input.store.readContextEntries(input.sessionId).filter((record) => record.runId === input.runId));
        appendInterruptedToolResults({
          interruptionReason,
          missingResults: missing,
          runId: input.runId,
          sessionId: input.sessionId,
          store: input.store,
          system: input.system
        });
        for (const { call } of missing) {
          messages.push({
            role: "tool",
            text: `工具调用 ${call.name} (${call.callId}) 已中断：${interruptionReason}。该结果仅用于闭合工具协议，不能视为工具执行成功。`,
            toolCallKey: call.callId
          });
        }
        applyPendingSteers();
        continue;
      }
      throw error;
    } finally {
      toolControl.release();
    }
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
    if (toolControl.interruptedBySteer() && input.registry.hasSteers(input.runId)) {
      applyPendingSteers();
      continue;
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
    protocol: input.protocol ?? "chat",
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
        answer: "",
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
  private delegations?: DelegationCoordinator;
  constructor(
    private readonly tools: ToolHost,
    private readonly rules: RuleSource = emptyRuleSource,
    private readonly capabilities: CapabilitySource = emptyCapabilitySource,
    private readonly context: ContextConfig = defaultContextConfig
  ) {}

  setDelegationCoordinator(delegations: DelegationCoordinator): void {
    this.delegations = delegations;
  }

  run(input: Omit<RunInput, "tools">): Promise<void> {
    const session = input.store.getSession(input.sessionId);
    if (session?.kind === "subagent" && session.agentId) {
      const definition = agentDefinition(session.agentId);
      return runAgent({
        ...input,
        agentPrompt: definition.systemPrompt,
        capabilities: this.capabilities,
        context: this.context,
        delegations: this.delegations,
        rules: this.rules,
        tools: createAgentToolHost(this.tools, definition)
      });
    }
    return runAgent({ ...input, capabilities: this.capabilities, context: this.context, delegations: this.delegations, rules: this.rules, tools: this.tools });
  }
}
