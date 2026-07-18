import { createHash, randomUUID } from "node:crypto";
import { platform } from "node:os";
import { CycleView, RecoveryCapsule, WorkspaceSessionView } from "../shared/runtimeTypes";
import {
  ContextCheckpoint,
  ContextRecord,
  ContextSectionMetric,
  ContextSemanticSummary,
  ContextTelemetry,
  NewContextRecord,
  checkpointText,
  contextRecordFingerprint,
  providerMessageFromRecord
} from "./contextRecords";
import { renderGuidance, resolveGuidance, ResolvedInstruction } from "./instructionResolver";
import { promptBlueprintRegistry } from "./promptBlueprintRegistry";
import { ProviderMessage, ToolDefinition } from "./providerTypes";

const DEFAULT_WINDOW = 1_000_000;
const DEFAULT_RATIO = 0.85;
const DEFAULT_MAX_OUTPUT = 64_000;
const DEFAULT_PROTOCOL_RESERVE = 8_000;
const DEFAULT_SAFETY_MARGIN = 16_000;

export type PreparedContext = {
  messages: ProviderMessage[];
  instructions: ResolvedInstruction[];
  checkpoint?: ContextCheckpoint;
  compacted: boolean;
  compactedRecordCount: number;
  contextTokenEstimate: number;
  retainedRecords: ContextRecord[];
  droppedRecords: ContextRecord[];
  droppedRecordCount: number;
  thresholdTokens: number;
  windowTokens: number;
  effectiveInputBudgetTokens: number;
  requestedMaxOutputTokens: number;
  sessionEnvelopeRecord?: NewContextRecord;
  recoveryRecord?: NewContextRecord;
  telemetry: ContextTelemetry;
  debugSnapshot: Record<string, unknown>;
};

export type PrepareContextInput = {
  session: WorkspaceSessionView;
  records: ContextRecord[];
  currentCycleKey: string;
  prompt: string;
  model: string;
  projectRoot: string;
  tools: ToolDefinition[];
  capabilityIndex?: string;
  memoryIndex?: string;
  skillIndex?: string;
  providerContextWindowTokens?: number;
  requestedMaxOutputTokens?: number;
  tokenCalibrationFactor?: number;
  latestUserInRecords?: boolean;
  semanticSummary?: ContextSemanticSummary;
};

export function getContextWindowTokens(): number {
  return Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? DEFAULT_WINDOW);
}

export function getRequestedMaxOutputTokens(): number {
  return Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT);
}

export function getEffectiveInputBudgetTokens(
  window = getContextWindowTokens(),
  requestedMaxOutputTokens = getRequestedMaxOutputTokens()
): number {
  const protocolReserve = Number(process.env.DEEPSEEK_PROTOCOL_RESERVE_TOKENS ?? DEFAULT_PROTOCOL_RESERVE);
  const safetyMargin = Number(process.env.DEEPSEEK_CONTEXT_SAFETY_TOKENS ?? DEFAULT_SAFETY_MARGIN);
  return Math.max(1, window - requestedMaxOutputTokens - protocolReserve - safetyMargin);
}

export function getCompactThresholdTokens(
  window = getContextWindowTokens(),
  requestedMaxOutputTokens = getRequestedMaxOutputTokens()
): number {
  return Math.max(1, Math.floor(
    getEffectiveInputBudgetTokens(window, requestedMaxOutputTokens) * Number(process.env.DEEPSEEK_COMPACT_TRIGGER_RATIO ?? DEFAULT_RATIO)
  ));
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) character.charCodeAt(0) <= 0x7f ? (ascii += 1) : (nonAscii += 1);
  return Math.ceil(ascii / 4 + nonAscii * 0.8);
}

function recordTokens(record: ContextRecord): number {
  return estimateTokens(JSON.stringify({
    kind: record.kind,
    text: record.text,
    reasoningContent: record.toolCalls?.length ? record.reasoningContent : undefined,
    toolCalls: record.toolCalls,
    toolCallKey: record.toolCallKey
  }));
}

function unique(values: Array<string | undefined>, limit = 40): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => value.length > 700 ? `${value.slice(0, 520)} … ${value.slice(-140)}` : value))]
    .slice(-limit);
}

function uniqueObjects<T>(values: T[], key: (value: T) => string, limit = 80): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(-limit);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？.!?])\s*|\n+/).map((value) => value.trim()).filter(Boolean);
}

function latestPlan(session: WorkspaceSessionView) {
  return [...session.cycles].reverse().find((cycle) => cycle.plan.length > 0)?.plan ?? [];
}

function buildCheckpoint(
  session: WorkspaceSessionView,
  dropped: ContextRecord[],
  previous?: ContextCheckpoint,
  semanticSummary?: ContextSemanticSummary
): ContextCheckpoint {
  const humanTexts = dropped.filter((record) => record.kind === "human_text").map((record) => record.text ?? "");
  const agentTexts = dropped.filter((record) => record.kind === "agent_text").map((record) => record.text ?? "");
  const toolResults = dropped.filter((record) => record.kind === "tool_result");
  const plan = latestPlan(session);
  const authoritativePlan = plan.length > 0 ? plan : previous?.currentPlan ?? [];
  const pendingWork = authoritativePlan.filter((step) => step.state !== "completed").map((step) => step.label);
  const changedFiles = session.cycles.flatMap((cycle) => cycle.workspaceDelta.files.map((file) => file.path));
  const fileChanges = session.cycles.flatMap((cycle) => cycle.workspaceDelta.files.map((file) => ({
    additions: file.additions,
    deletions: file.deletions,
    operation: file.operation,
    path: file.path
  })));
  const approvals = session.cycles.flatMap((cycle) => cycle.approvals.map((approval) => ({
    state: approval.state,
    target: approval.target,
    title: approval.title
  })));
  const failures = [
    ...(previous?.failures ?? []),
    ...session.cycles.map((cycle) => cycle.failure),
    ...toolResults.filter((record) => record.isError).map((record) => record.text)
  ];
  const validations = toolResults
    .filter((record) => record.metadata?.operationClass === "verify")
    .map((record) => record.text);
  const inspectedFiles = dropped
    .filter((record) => record.metadata?.operationClass === "inspect" || record.metadata?.operationClass === "search")
    .map((record) => String(record.metadata?.target ?? ""));
  return {
    approvals: uniqueObjects([...(previous?.approvals ?? []), ...approvals], (approval) => `${approval.title}:${approval.target}:${approval.state}`),
    changedFiles: unique([...(previous?.changedFiles ?? []), ...changedFiles]),
    compactedRecordCount: (previous?.compactedRecordCount ?? 0) + dropped.length,
    compactedThroughSequence: dropped.at(-1)?.sequence ?? previous?.compactedThroughSequence ?? 0,
    constraints: unique([
      ...(previous?.constraints ?? []),
      ...(semanticSummary?.constraints ?? []),
      ...humanTexts.flatMap(sentences).filter((line) => /必须|不要|不得|不能|只需|只要|保持|注意|应该|需要/.test(line))
    ]),
    currentPlan: authoritativePlan,
    decisions: unique([
      ...(previous?.decisions ?? []),
      ...(semanticSummary?.decisions ?? []),
      ...agentTexts.flatMap(sentences).filter((line) => /采用|决定|改为|实现为|方案|原因|根因/.test(line))
    ]),
    failures: unique(failures),
    fileChanges: uniqueObjects([...(previous?.fileChanges ?? []), ...fileChanges], (file) => `${file.path}:${file.operation}:${file.additions}:${file.deletions}`),
    inspectedFiles: unique([...(previous?.inspectedFiles ?? []), ...inspectedFiles]),
    nextActions: unique(pendingWork.length ? pendingWork : authoritativePlan.length > 0 ? [] : previous?.nextActions ?? []),
    objective: (semanticSummary?.objective || previous?.objective || humanTexts.find(Boolean) || session.cycles[0]?.prompt || "继续当前项目任务").slice(0, 1_200),
    pendingWork: unique(authoritativePlan.length > 0 ? pendingWork : previous?.pendingWork ?? []),
    semanticSummary,
    toolStates: uniqueObjects([
      ...(previous?.toolStates ?? []),
      ...toolResults.map((record) => ({
        status: record.isError ? "failed" as const : "succeeded" as const,
        target: String(record.metadata?.target ?? ""),
        toolName: record.toolName ?? "unknown"
      }))
    ], (tool) => `${tool.toolName}:${tool.target}:${tool.status}`),
    unresolvedQuestions: unique([...(previous?.unresolvedQuestions ?? []), ...(semanticSummary?.unresolvedQuestions ?? [])]),
    validations: unique([...(previous?.validations ?? []), ...validations])
  };
}

function latestCheckpoint(records: ContextRecord[]): { record?: ContextRecord; checkpoint?: ContextCheckpoint } {
  const record = [...records].reverse().find((item) => item.kind === "checkpoint" && item.checkpoint);
  return { checkpoint: record?.checkpoint, record };
}

function unmatchedToolRecords(records: ContextRecord[], boundary: number): ContextRecord[] {
  const results = new Set(records.filter((record) => record.kind === "tool_result").map((record) => record.toolCallKey));
  return records.filter((record) =>
    record.sequence <= boundary &&
    record.kind === "agent_text" &&
    record.toolCalls?.some((call) => !results.has(call.callKey))
  );
}

function chooseRecentRecords(records: ContextRecord[], targetTokens: number): ContextRecord[] {
  const selected: ContextRecord[] = [];
  let tokens = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const cost = recordTokens(record);
    if (selected.length > 0 && tokens + cost > targetTokens && record.kind === "human_text") {
      selected.unshift(record);
      break;
    }
    selected.unshift(record);
    tokens += cost;
  }
  while (selected.length > 0 && selected[0].kind !== "human_text" && selected[0].kind !== "agent_text") selected.shift();
  return selected;
}

function recoveryFor(session: WorkspaceSessionView, prompt: string): RecoveryCapsule | undefined {
  if (!/^(?:请)?(?:继续|接着|重试|恢复|继续工作|接着做|继续做|还是不行)(?:\s|[，,。.!！]|$)/i.test(prompt.trim())) return undefined;
  return [...session.cycles].reverse().find((cycle) => cycle.recovery)?.recovery;
}

function recoveryText(recovery: RecoveryCapsule): string {
  return [
    "<recovery_capsule>",
    "以下是中断或失败后由 Runtime 证据恢复出的事实，不是新的用户要求。执行前核对工作区，不要重复已经完成的操作。",
    escapeEnvelopeText(JSON.stringify({
      changedFiles: recovery.changedFiles,
      completedOperations: recovery.completedOperations,
      failure: { message: recovery.failureMessage, type: recovery.failureType },
      interruptedOperations: recovery.interruptedOperations,
      lastProgress: recovery.lastProgress,
      plan: recovery.plan
    })),
    "</recovery_capsule>"
  ].join("\n");
}

function escapeEnvelopeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stableEnvelope(input: PrepareContextInput, guidance: ResolvedInstruction[]): string {
  const body = [
    `<stable_session_context revision="${createHash("sha256").update(guidance.map((unit) => unit.revisionHash).join(":" )).digest("hex")}">`,
    renderGuidance(guidance, "stable"),
    `<stable_environment>${escapeEnvelopeText(JSON.stringify({ projectRoot: input.projectRoot, platform: platform(), shellFamily: process.env.SHELL?.split("/").at(-1) ?? "unknown", app: "DeepSeeker CodeAgent" }))}</stable_environment>`,
    `<memory_index>${escapeEnvelopeText(input.memoryIndex?.trim() || "No curated memory facts are active.")}</memory_index>`,
    `<capability_index>${escapeEnvelopeText(input.capabilityIndex?.trim() || "Long-tail capabilities can be discovered with the stable capability tools.")}</capability_index>`,
    `<skill_index>${escapeEnvelopeText(input.skillIndex?.trim() || "No project skills are indexed.")}</skill_index>`,
    "</stable_session_context>"
  ];
  return body.filter(Boolean).join("\n");
}

function envelopeSection(text: string, tag: "memory_index" | "capability_index" | "skill_index"): string {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
}

function envelopeWithoutIndexes(text: string): string {
  return text.replace(/<(memory_index|capability_index|skill_index)>[\s\S]*?<\/\1>/g, "");
}

function metric(
  section: ContextSectionMetric["section"],
  source: string,
  text: string,
  cacheClass: ContextSectionMetric["cacheClass"],
  extras: Partial<ContextSectionMetric> = {}
): ContextSectionMetric {
  return { cacheClass, estimatedTokens: estimateTokens(text), section, source, ...extras };
}

function uniqueRecords(records: ContextRecord[]): ContextRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.recordKey)) return false;
    seen.add(record.recordKey);
    return true;
  }).sort((left, right) => left.sequence - right.sequence);
}

export function prepareSessionContext(input: PrepareContextInput): PreparedContext {
  const calibrationFactor = Math.min(2.5, Math.max(0.4, input.tokenCalibrationFactor ?? 1));
  const blueprint = promptBlueprintRegistry.compileSystem(input.model);
  const prior = latestCheckpoint(input.records);
  const existingEnvelope = [...input.records].reverse().find((record) => record.kind === "session_context" && record.text);
  const startupGuidance = resolveGuidance({ phase: "session_start", projectRoot: input.projectRoot });
  const frozenEnvelope = existingEnvelope?.text ?? stableEnvelope(input, startupGuidance);
  const afterCheckpoint = input.records.filter((record) =>
    !["checkpoint", "session_context", "recovery_capsule", "runtime_fact"].includes(record.kind) &&
    record.sequence > (prior.checkpoint?.compactedThroughSequence ?? 0)
  );
  const recovery = recoveryFor(input.session, input.prompt);
  const recoveryEnvelope = recovery ? recoveryText(recovery) : undefined;
  const toolText = JSON.stringify(input.tools);
  const configuredWindow = input.session.contextWindowTokens || getContextWindowTokens();
  const windowTokens = input.providerContextWindowTokens
    ? Math.min(configuredWindow, input.providerContextWindowTokens)
    : configuredWindow;
  const requestedMaxOutputTokens = Math.min(input.requestedMaxOutputTokens ?? getRequestedMaxOutputTokens(), Math.max(1, windowTokens - 1));
  const effectiveInputBudgetTokens = getEffectiveInputBudgetTokens(windowTokens, requestedMaxOutputTokens);
  const providerAwareThreshold = getCompactThresholdTokens(windowTokens, requestedMaxOutputTokens);
  const thresholdTokens = Math.min(input.session.compactThresholdTokens || providerAwareThreshold, providerAwareThreshold);
  const initialMessages: ProviderMessage[] = [
    { role: "system", text: blueprint.text },
    { role: "user", text: frozenEnvelope },
    ...(prior.checkpoint ? [{ role: "user" as const, text: checkpointText(prior.checkpoint) }] : []),
    ...afterCheckpoint.map(providerMessageFromRecord).filter((message): message is ProviderMessage => Boolean(message)),
    ...(recoveryEnvelope ? [{ role: "user" as const, text: recoveryEnvelope }] : []),
    ...(input.latestUserInRecords ? [] : [{ role: "user" as const, text: input.prompt }])
  ];
  const initialEstimate = Math.ceil(estimateProviderRequestTokens(initialMessages, input.tools) * calibrationFactor);
  const shouldCompact = Math.max(initialEstimate, input.session.contextTokenEstimate) >= thresholdTokens;
  let retainedRecords = afterCheckpoint;
  let dropped: ContextRecord[] = [];
  let checkpoint = prior.checkpoint;
  if (shouldCompact && afterCheckpoint.length > 1) {
    const preferredRecent = chooseRecentRecords(afterCheckpoint, Math.floor(thresholdTokens * 0.35));
    const openToolRecords = unmatchedToolRecords(afterCheckpoint, Number.MAX_SAFE_INTEGER);
    const openCallKeys = new Set(openToolRecords.flatMap((record) => record.toolCalls?.map((call) => call.callKey) ?? []));
    const pairedOpenResults = afterCheckpoint.filter((record) => record.kind === "tool_result" && record.toolCallKey && openCallKeys.has(record.toolCallKey));
    const protectedKeys = new Set([...preferredRecent, ...openToolRecords, ...pairedOpenResults].map((record) => record.recordKey));
    const earliestOpenSequence = openToolRecords.length > 0 ? Math.min(...openToolRecords.map((record) => record.sequence)) : undefined;
    dropped = afterCheckpoint.filter((record) => !protectedKeys.has(record.recordKey) && (earliestOpenSequence === undefined || record.sequence < earliestOpenSequence));
    if (dropped.length > 0) {
      checkpoint = buildCheckpoint(input.session, dropped, prior.checkpoint, input.semanticSummary);
      const droppedKeys = new Set(dropped.map((record) => record.recordKey));
      retainedRecords = uniqueRecords(afterCheckpoint.filter((record) => !droppedKeys.has(record.recordKey)));
    }
  }

  // Root guidance is frozen until compaction. A successful compaction starts a new frozen prefix.
  const sessionEnvelopeText = dropped.length > 0 ? stableEnvelope(input, startupGuidance) : frozenEnvelope;
  const checkpointMessage = checkpoint ? checkpointText(checkpoint) : undefined;
  const historyMessages = retainedRecords.map(providerMessageFromRecord).filter((message): message is ProviderMessage => Boolean(message));
  const messages: ProviderMessage[] = [
    { role: "system", text: blueprint.text },
    { role: "user", text: sessionEnvelopeText },
    ...(checkpointMessage ? [{ role: "user" as const, text: checkpointMessage }] : []),
    ...historyMessages,
    ...(recoveryEnvelope ? [{ role: "user" as const, text: recoveryEnvelope }] : []),
    ...(input.latestUserInRecords ? [] : [{ role: "user" as const, text: input.prompt }])
  ];
  const updateRecords = retainedRecords.filter((record) => record.kind === "context_update");
  const trajectoryRecords = retainedRecords.filter((record) => record.kind !== "context_update");
  const memoryIndexText = envelopeSection(sessionEnvelopeText, "memory_index");
  const capabilityIndexText = [
    envelopeSection(sessionEnvelopeText, "capability_index"),
    envelopeSection(sessionEnvelopeText, "skill_index")
  ].filter(Boolean).join("\n");
  const envelopeSource = dropped.length > 0 ? "generated_after_compaction" : existingEnvelope?.recordKey ?? "generated";
  const sections: ContextSectionMetric[] = [
    metric("tools", "ProviderRequest.tools", toolText, "stable", { role: "top_level", survivesCompaction: true }),
    metric("prompt_kernel", blueprint.version, blueprint.text, "stable", { role: "system", survivesCompaction: true }),
    metric("stable_session", envelopeSource, envelopeWithoutIndexes(sessionEnvelopeText), "session_stable", { role: "user", survivesCompaction: true }),
    metric("memory_index", "StableSessionEnvelope.memory_index", memoryIndexText, "session_stable", { role: "user", survivesCompaction: true }),
    metric("capability_index", "StableSessionEnvelope.capability_index", capabilityIndexText, "session_stable", { role: "user", survivesCompaction: true }),
    ...(checkpointMessage ? [metric("checkpoint", "ContextCheckpoint", checkpointMessage, "compaction_stable", { role: "user", survivesCompaction: true })] : []),
    metric("recent_history", `${trajectoryRecords.length} records`, trajectoryRecords
      .map(providerMessageFromRecord)
      .filter((message): message is ProviderMessage => Boolean(message))
      .map((message) => JSON.stringify(message))
      .join("\n"), "dynamic", { survivesCompaction: false }),
    ...updateRecords.map((record) => metric("context_update", String(record.metadata?.sourceFile ?? record.recordKey), record.text ?? "", "dynamic", {
      loadingReason: String(record.metadata?.activationReason ?? "lazy activation"),
      recordKey: record.recordKey,
      revisionHash: String(record.metadata?.revisionHash ?? ""),
      role: "user",
      survivesCompaction: false,
      trust: String(record.metadata?.trust ?? "")
    })),
    ...(recoveryEnvelope ? [metric("recovery_capsule", "Runtime recovery evidence", recoveryEnvelope, "dynamic", { role: "user", survivesCompaction: false })] : []),
    metric("latest_user", "User", input.latestUserInRecords ? "" : input.prompt, "dynamic", { role: "user", survivesCompaction: true })
  ];
  const rawEstimatedInputTokens = estimateProviderRequestTokens(messages, input.tools);
  const estimatedInputTokens = Math.ceil(rawEstimatedInputTokens * calibrationFactor);
  const prefixHash = createHash("sha256").update([toolText, blueprint.hash, sessionEnvelopeText, checkpointMessage ?? ""].join("\n")).digest("hex");
  const telemetry: ContextTelemetry = {
    blueprintHash: blueprint.hash,
    blueprintVersion: blueprint.version,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    compactAfterTokens: dropped.length > 0 ? estimatedInputTokens : undefined,
    compactBeforeTokens: dropped.length > 0 ? initialEstimate : undefined,
    compactThresholdTokens: thresholdTokens,
    createdAt: new Date().toISOString(),
    cycleKey: input.currentCycleKey,
    droppedRecordCount: dropped.length,
    droppedRecords: dropped.map((record) => ({ recordKey: record.recordKey, reason: "superseded_by_checkpoint" })),
    effectiveInputBudgetTokens,
    estimatedInputTokens,
    model: input.model,
    prefixHash,
    protocolReserveTokens: Number(process.env.DEEPSEEK_PROTOCOL_RESERVE_TOKENS ?? DEFAULT_PROTOCOL_RESERVE),
    providerContextWindowTokens: windowTokens,
    recordFingerprint: contextRecordFingerprint(retainedRecords),
    requestedMaxOutputTokens,
    rawEstimatedInputTokens,
    retainedRecordCount: retainedRecords.length,
    retainedRecordKeys: retainedRecords.map((record) => record.recordKey),
    safetyMarginTokens: Number(process.env.DEEPSEEK_CONTEXT_SAFETY_TOKENS ?? DEFAULT_SAFETY_MARGIN),
    sections,
    sessionKey: input.session.sessionKey,
    telemetryKey: `context_telemetry_${randomUUID()}`,
    tokenCalibrationFactor: calibrationFactor,
    truncationEvents: input.records.filter((record) => record.wasTruncated).slice(-100).map((record) => ({
      artifactRef: record.artifactRef,
      originalBytes: Number(record.metadata?.originalBytes) || undefined,
      recordKey: record.recordKey,
      retainedBytes: Number(record.metadata?.retainedBytes) || undefined,
      toolName: record.toolName
    }))
  };
  telemetry.events = [
    ...updateRecords.map((record) => ({
      createdAt: record.createdAt,
      kind: String(record.metadata?.updateKind) === "skill"
        ? "skill_activated" as const
        : String(record.metadata?.updateKind) === "capability"
          ? "capability_loaded" as const
          : "guidance_activated" as const,
      label: String(record.metadata?.label ?? record.metadata?.sourceFile ?? "Context update"),
      recordKey: record.recordKey,
      source: String(record.metadata?.sourceFile ?? "")
    })),
    ...telemetry.truncationEvents.map((event) => ({
      createdAt: new Date().toISOString(),
      kind: "evidence_truncated" as const,
      label: event.toolName ?? event.recordKey,
      recordKey: event.recordKey,
      source: event.artifactRef
    }))
  ];
  const refreshEnvelope = !existingEnvelope || dropped.length > 0;
  return {
    checkpoint,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    contextTokenEstimate: estimatedInputTokens,
    debugSnapshot: {
      blueprint: { hash: blueprint.hash, version: blueprint.version },
      guidanceSources: startupGuidance.map(({ guidanceId, origin, revisionHash, sourceFile, trust }) => ({ guidanceId, origin, revisionHash, sourceFile, trust })),
      layout: sections,
      messageRoles: messages.map((message) => message.role),
      prefixHash,
      recordKeys: retainedRecords.map((record) => record.recordKey),
      tools: input.tools.map((tool) => tool.name)
    },
    droppedRecordCount: dropped.length,
    droppedRecords: dropped,
    effectiveInputBudgetTokens,
    instructions: startupGuidance,
    messages,
    recoveryRecord: recoveryEnvelope ? {
      cycleKey: input.currentCycleKey,
      kind: "recovery_capsule",
      metadata: { failureType: recovery?.failureType },
      sessionKey: input.session.sessionKey,
      source: "runtime",
      text: recoveryEnvelope
    } : undefined,
    requestedMaxOutputTokens,
    retainedRecords,
    sessionEnvelopeRecord: refreshEnvelope ? {
      cycleKey: input.currentCycleKey,
      kind: "session_context",
      metadata: { guidanceKeys: startupGuidance.map((unit) => unit.instructionKey), prefixHash },
      sessionKey: input.session.sessionKey,
      source: "runtime",
      text: sessionEnvelopeText
    } : undefined,
    telemetry,
    thresholdTokens,
    windowTokens
  };
}

export function estimateProviderRequestTokens(messages: ProviderMessage[], tools: ToolDefinition[]): number {
  return estimateTokens(JSON.stringify({ messages, tools }));
}

export function findNewPathInstructions(
  projectRoot: string,
  activePaths: string[],
  knownInstructionKeys: Set<string>
): ResolvedInstruction[] {
  return resolveGuidance({ activePaths, phase: "path_access", projectRoot })
    .filter((instruction) => !knownInstructionKeys.has(instruction.instructionKey));
}

export function renderAdditionalInstructions(instructions: ResolvedInstruction[]): ProviderMessage | undefined {
  const text = renderGuidance(instructions, "update");
  return text ? { role: "user", text } : undefined;
}

export function contextUpdateRecord(
  sessionKey: string,
  cycleKey: string,
  instructions: ResolvedInstruction[],
  trigger: "read_result" | "mutation_preflight"
): NewContextRecord | undefined {
  const text = renderGuidance(instructions, "update");
  if (!text) return undefined;
  return {
    cycleKey,
    kind: "context_update",
    metadata: {
      activationReason: trigger,
      guidanceKeys: instructions.map((unit) => unit.instructionKey),
      label: instructions.length === 1 ? instructions[0].sourceFile : `${instructions.length} guidance units`,
      revisionHash: instructions.map((unit) => unit.revisionHash).join(","),
      sourceFile: instructions.map((unit) => unit.sourceFile).join(","),
      trust: instructions.map((unit) => unit.trust).join(","),
      updateKind: "path_guidance"
    },
    sessionKey,
    source: "runtime",
    text
  };
}

export function previousCycleForRecovery(session: WorkspaceSessionView): CycleView | undefined {
  return [...session.cycles].reverse().find((cycle) => cycle.recovery);
}
