import { createHash, randomUUID } from "node:crypto";
import { Run, ResumeState, Session } from "../../shared/contracts/runtime";
import {
  Checkpoint,
  ContextEntry,
  ContextSectionStats,
  ContextSummary,
  ContextStats,
  ContextInput,
} from "../../shared/contracts/context";
import { renderCheckpoint, systemReminder, systemReminderWithRevision } from "../../shared/domain/context";
import { contextFingerprint } from "./contextFingerprint";
import { emptyRuleSource, ResolvedRule, RuleSource } from "../../shared/contracts/rules";
import { protocolSafeModelMessages } from "../../shared/domain/toolProtocol";
import { prompts } from "./prompts";
import { ModelMessage, ToolSpec } from "../../shared/contracts/provider";

const DEFAULT_WINDOW = 1_000_000;
const DEFAULT_RATIO = 0.85;
const DEFAULT_MAX_OUTPUT = 64_000;
const DEFAULT_PROTOCOL_RESERVE = 8_000;
const DEFAULT_SAFETY_MARGIN = 16_000;

export type ContextConfig = {
  compactRatio: number;
  maxOutputTokens: number;
  maxSummaryChars: number;
  platform: string;
  protocolReserveTokens: number;
  safetyMarginTokens: number;
  shellFamily: string;
  locale: string;
  windowTokens: number;
};

export const defaultContextConfig: ContextConfig = {
  compactRatio: DEFAULT_RATIO,
  maxOutputTokens: DEFAULT_MAX_OUTPUT,
  maxSummaryChars: 80_000,
  locale: "en-US",
  platform: "unknown",
  protocolReserveTokens: DEFAULT_PROTOCOL_RESERVE,
  safetyMarginTokens: DEFAULT_SAFETY_MARGIN,
  shellFamily: "unknown",
  windowTokens: DEFAULT_WINDOW
};

export type BuiltContext = {
  messages: ModelMessage[];
  instructions: ResolvedRule[];
  checkpoint?: Checkpoint;
  compacted: boolean;
  compactedRecordCount: number;
  contextTokens: number;
  retainedRecords: ContextEntry[];
  droppedRecords: ContextEntry[];
  droppedRecordCount: number;
  thresholdTokens: number;
  windowTokens: number;
  effectiveInputBudgetTokens: number;
  requestedMaxOutputTokens: number;
  sessionEnvelopeRecord?: ContextInput;
  recoveryRecord?: ContextInput;
  telemetry: ContextStats;
  debugSnapshot: Record<string, unknown>;
};

export type BuildInput = {
  context?: ContextConfig;
  session: Session;
  records: ContextEntry[];
  rules?: RuleSource;
  runId: string;
  prompt: string;
  model: string;
  projectRoot: string;
  tools: ToolSpec[];
  capabilityIndex?: string;
  memoryIndex?: string;
  skillIndex?: string;
  providerContextWindowTokens?: number;
  requestedMaxOutputTokens?: number;
  tokenCalibrationFactor?: number;
  latestUserInRecords?: boolean;
  semanticSummary?: ContextSummary;
};

export function getContextWindowTokens(config: ContextConfig = defaultContextConfig): number {
  return config.windowTokens;
}

export function getRequestedMaxOutputTokens(config: ContextConfig = defaultContextConfig): number {
  return config.maxOutputTokens;
}

export function getEffectiveInputBudgetTokens(
  window = getContextWindowTokens(),
  requestedMaxOutputTokens = getRequestedMaxOutputTokens(),
  config: ContextConfig = defaultContextConfig
): number {
  return Math.max(1, window - requestedMaxOutputTokens - config.protocolReserveTokens - config.safetyMarginTokens);
}

export function getCompactThresholdTokens(
  window = getContextWindowTokens(),
  requestedMaxOutputTokens = getRequestedMaxOutputTokens(),
  config: ContextConfig = defaultContextConfig
): number {
  return Math.max(1, Math.floor(
    getEffectiveInputBudgetTokens(window, requestedMaxOutputTokens, config) * config.compactRatio
  ));
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) character.charCodeAt(0) <= 0x7f ? (ascii += 1) : (nonAscii += 1);
  return Math.ceil(ascii / 4 + nonAscii * 0.8);
}

function recordTokens(record: ContextEntry): number {
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

function latestTasks(session: Session) {
  return [...session.runs].reverse().find((run) => (run.tasks ?? []).length > 0)?.tasks ?? [];
}

function latestPlan(session: Session) {
  return [...(session.plans ?? [])]
    .filter((plan) => plan.status !== "superseded")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.revision - left.revision)[0];
}

function buildCheckpoint(
  session: Session,
  dropped: ContextEntry[],
  previous?: Checkpoint,
  semanticSummary?: ContextSummary
): Checkpoint {
  const humanTexts = dropped.filter((record) => record.kind === "human_text").map((record) => record.text ?? "");
  const agentTexts = dropped.filter((record) => record.kind === "agent_text").map((record) => record.text ?? "");
  const toolResults = dropped.filter((record) => record.kind === "tool_result");
  const tasks = latestTasks(session);
  const authoritativeTasks = tasks.length > 0 ? tasks : previous?.currentTasks ?? [];
  const pendingWork = authoritativeTasks.filter((task) => task.status !== "completed").map((task) => task.label);
  const changedFiles = session.runs.flatMap((run) => run.changes.files.map((file) => file.path));
  const fileChanges = session.runs.flatMap((run) => run.changes.files.map((file) => ({
    additions: file.additions,
    deletions: file.deletions,
    operation: file.operation,
    path: file.path
  })));
  const approvals = session.runs.flatMap((run) => run.approvals.map((approval) => ({
    state: approval.state,
    target: approval.target,
    title: approval.title
  })));
  const failures = [
    ...(previous?.failures ?? []),
    ...session.runs.map((run) => run.error),
    ...toolResults.filter((record) => record.isError).map((record) => record.text)
  ];
  const validations = toolResults
    .filter((record) => record.metadata?.action === "verify")
    .map((record) => record.text);
  const inspectedFiles = dropped
    .filter((record) => record.metadata?.action === "inspect" || record.metadata?.action === "search")
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
    currentTasks: authoritativeTasks,
    decisions: unique([
      ...(previous?.decisions ?? []),
      ...(semanticSummary?.decisions ?? []),
      ...agentTexts.flatMap(sentences).filter((line) => /采用|决定|改为|实现为|方案|原因|根因/.test(line))
    ]),
    mode: session.mode ?? previous?.mode ?? "work",
    plan: latestPlan(session) ?? previous?.plan,
    failures: unique(failures),
    fileChanges: uniqueObjects([...(previous?.fileChanges ?? []), ...fileChanges], (file) => `${file.path}:${file.operation}:${file.additions}:${file.deletions}`),
    inspectedFiles: unique([...(previous?.inspectedFiles ?? []), ...inspectedFiles]),
    nextActions: unique(pendingWork.length ? pendingWork : authoritativeTasks.length > 0 ? [] : previous?.nextActions ?? []),
    objective: (semanticSummary?.objective || previous?.objective || humanTexts.find(Boolean) || session.runs[0]?.prompt || "继续当前项目任务").slice(0, 1_200),
    pendingWork: unique(authoritativeTasks.length > 0 ? pendingWork : previous?.pendingWork ?? []),
    semanticSummary,
    toolStates: uniqueObjects([
      ...(previous?.toolStates ?? []),
      ...toolResults.map((record) => ({
        status: record.isError ? "failed" as const : "completed" as const,
        target: String(record.metadata?.target ?? ""),
        toolName: record.toolName ?? "unknown"
      }))
    ], (tool) => `${tool.toolName}:${tool.target}:${tool.status}`),
    unresolvedQuestions: unique([...(previous?.unresolvedQuestions ?? []), ...(semanticSummary?.unresolvedQuestions ?? [])]),
    validations: unique([...(previous?.validations ?? []), ...validations])
  };
}

function latestCheckpoint(records: ContextEntry[]): { record?: ContextEntry; checkpoint?: Checkpoint } {
  const record = [...records].reverse().find((item) => item.kind === "checkpoint" && item.checkpoint);
  return { checkpoint: record?.checkpoint, record };
}

function unmatchedToolRecords(records: ContextEntry[], boundary: number): ContextEntry[] {
  const results = new Set(records.filter((record) => record.kind === "tool_result").map((record) => record.toolCallKey));
  return records.filter((record) =>
    record.sequence <= boundary &&
    record.kind === "agent_text" &&
    record.toolCalls?.some((call) => !results.has(call.callId))
  );
}

function chooseRecentRecords(records: ContextEntry[], targetTokens: number): ContextEntry[] {
  const selected: ContextEntry[] = [];
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

function recoveryFor(session: Session, prompt: string): ResumeState | undefined {
  if (!/^(?:请)?(?:继续|接着|重试|恢复|继续工作|接着做|继续做|还是不行)(?:\s|[，,。.!！]|$)/i.test(prompt.trim())) return undefined;
  return [...session.runs].reverse().find((run) => run.resume)?.resume;
}

function recoveryText(resume: ResumeState): string {
  const body = escapeEnvelopeText(JSON.stringify({
    changedFiles: resume.changedFiles,
    completedOperations: resume.completedOperations,
    error: { message: resume.failureMessage, type: resume.failureType },
    interruptedOperations: resume.interruptedOperations,
    lastProgress: resume.lastProgress,
    plan: resume.plan ? {
      markdown: resume.plan.markdown,
      planId: resume.plan.planId,
      revision: resume.plan.revision,
      status: resume.plan.status,
      title: resume.plan.title
    } : undefined,
    tasks: resume.tasks
  }));
  return systemReminder("recovery", `Runtime recovered these facts from interrupted or failed work. Not a new user request. Verify workspace before proceeding; do not repeat completed operations.\n${body}`);
}

function escapeEnvelopeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function modeText(session: Session): string {
  const plan = latestPlan(session);
  const mode = session.mode ?? "work";
  const planEntry = session.planEntry ?? "suggest";
  const body = escapeEnvelopeText(JSON.stringify({
    mode,
    plan: plan ? { planId: plan.planId, revision: plan.revision, status: plan.status, title: plan.title } : undefined
  }));
  return systemReminder("mode", `mode="${mode}" plan_entry="${planEntry}"\nRuntime working mode. Not a user request. Tool execution is ultimately decided by Runtime policy.\n${body}`);
}

function stableEnvelope(input: BuildInput, guidance: ResolvedRule[]): string {
  const context = input.context ?? defaultContextConfig;
  const env = {
    projectRoot: input.projectRoot,
    platform: context.platform,
    shellFamily: context.shellFamily,
    locale: context.locale,
    date: new Date().toISOString().slice(0, 10),
    model: input.model,
    app: "DeepSeeker CodeAgent"
  };
  const guidanceText = (input.rules ?? emptyRuleSource).render(guidance, "stable");
  const memory = input.memoryIndex?.trim() || "No curated memory facts are active.";
  const capability = input.capabilityIndex?.trim() || "Long-tail capabilities can be discovered with the stable capability tools.";
  const skill = input.skillIndex?.trim() || "No project skills are indexed.";

  const body = [
    `<environment>${escapeEnvelopeText(JSON.stringify(env))}</environment>`,
    guidanceText,
    `<memory-index>${escapeEnvelopeText(memory)}</memory-index>`,
    `<capability-index>${escapeEnvelopeText(capability)}</capability-index>`,
    `<skill-index>${escapeEnvelopeText(skill)}</skill-index>`
  ].filter(Boolean).join("\n");

  // ADR-007: revision hash 完整化 — 纳入 guidance + environment + indexes 全部可变内容
  const revision = createHash("sha256").update([
    guidance.map((activity) => activity.revisionHash).join(":"),
    JSON.stringify(env),
    memory, capability, skill
  ].join("\n")).digest("hex");

  return systemReminderWithRevision("context", revision, body);
}

/**
 * 计算给定输入的 session 层 revision hash(用于 frozen 复用验证)。
 * 与 stableEnvelope 内部的 hash 计算逻辑完全一致。
 */
export function sessionRevisionHash(input: BuildInput, guidance: ResolvedRule[]): string {
  const context = input.context ?? defaultContextConfig;
  const env = {
    projectRoot: input.projectRoot,
    platform: context.platform,
    shellFamily: context.shellFamily,
    locale: context.locale,
    date: new Date().toISOString().slice(0, 10),
    model: input.model,
    app: "DeepSeeker CodeAgent"
  };
  const memory = input.memoryIndex?.trim() || "No curated memory facts are active.";
  const capability = input.capabilityIndex?.trim() || "Long-tail capabilities can be discovered with the stable capability tools.";
  const skill = input.skillIndex?.trim() || "No project skills are indexed.";
  return createHash("sha256").update([
    guidance.map((activity) => activity.revisionHash).join(":"),
    JSON.stringify(env),
    memory, capability, skill
  ].join("\n")).digest("hex");
}

/**
 * 从已存的 session_context 记录文本中提取 revision 属性。
 * 兼容新旧两种标签格式(system-reminder 和 stable_session_context)。
 */
function extractRevision(envelopeText: string): string | undefined {
  return envelopeText.match(/revision="([a-f0-9]+)"/)?.[1];
}

// ADR-007: 兼容新旧标签格式(连字符 memory-index 和下划线 memory_index)
function envelopeSection(text: string, tag: "memory_index" | "capability_index" | "skill_index"): string {
  const hyphenTag = tag.replace(/_/g, "-");
  return text.match(new RegExp(`<(?:${tag}|${hyphenTag})>([\\s\\S]*?)</(?:${tag}|${hyphenTag})>`))?.[1]?.trim() ?? "";
}

function envelopeWithoutIndexes(text: string): string {
  return text.replace(/<(?:memory_index|memory-index|capability_index|capability-index|skill_index|skill-index)>[\s\S]*?<\/(?:memory_index|memory-index|capability_index|capability-index|skill_index|skill-index)>/g, "");
}

function metric(
  section: ContextSectionStats["section"],
  source: string,
  text: string,
  cacheClass: ContextSectionStats["cacheClass"],
  extras: Partial<ContextSectionStats> = {}
): ContextSectionStats {
  return { cacheClass, estimatedTokens: estimateTokens(text), section, source, ...extras };
}

function uniqueRecords(records: ContextEntry[]): ContextEntry[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.recordId)) return false;
    seen.add(record.recordId);
    return true;
  }).sort((left, right) => left.sequence - right.sequence);
}

export function prepareSessionContext(input: BuildInput): BuiltContext {
  const context = input.context ?? defaultContextConfig;
  const calibrationFactor = Math.min(2.5, Math.max(0.4, input.tokenCalibrationFactor ?? 1));
  const blueprint = prompts.compileSystem(input.model);
  const prior = latestCheckpoint(input.records);
  const existingEnvelope = [...input.records].reverse().find((record) => record.kind === "session_context" && record.text);
  const startupGuidance = (input.rules ?? emptyRuleSource).resolve({ phase: "session_start", projectRoot: input.projectRoot });
  const frozenEnvelope = existingEnvelope?.text ?? stableEnvelope(input, startupGuidance);
  const afterCheckpoint = input.records.filter((record) =>
    !["checkpoint", "session_context", "recovery_capsule", "runtime_fact"].includes(record.kind) &&
    record.sequence > (prior.checkpoint?.compactedThroughSequence ?? 0)
  );
  const resume = recoveryFor(input.session, input.prompt);
  const recoveryEnvelope = resume ? recoveryText(resume) : undefined;
  const modeEnvelope = input.latestUserInRecords ? undefined : modeText(input.session);
  const toolText = JSON.stringify(input.tools);
  const configuredWindow = input.session.contextWindowTokens || getContextWindowTokens(context);
  const windowTokens = input.providerContextWindowTokens
    ? Math.min(configuredWindow, input.providerContextWindowTokens)
    : configuredWindow;
  const requestedMaxOutputTokens = Math.min(input.requestedMaxOutputTokens ?? getRequestedMaxOutputTokens(context), Math.max(1, windowTokens - 1));
  const effectiveInputBudgetTokens = getEffectiveInputBudgetTokens(windowTokens, requestedMaxOutputTokens, context);
  const providerAwareThreshold = getCompactThresholdTokens(windowTokens, requestedMaxOutputTokens, context);
  const thresholdTokens = Math.min(input.session.compactThresholdTokens || providerAwareThreshold, providerAwareThreshold);
  const initialMessages: ModelMessage[] = [
    { role: "system", text: blueprint.text },
    { role: "user", text: frozenEnvelope },
    ...(prior.checkpoint ? [{ role: "user" as const, text: renderCheckpoint(prior.checkpoint) }] : []),
    ...protocolSafeModelMessages(afterCheckpoint),
    ...(recoveryEnvelope ? [{ role: "user" as const, text: recoveryEnvelope }] : []),
    ...(modeEnvelope ? [{ role: "user" as const, text: modeEnvelope }] : []),
    ...(input.latestUserInRecords ? [] : [{ role: "user" as const, text: input.prompt }])
  ];
  const initialEstimate = Math.ceil(estimateProviderRequestTokens(initialMessages, input.tools) * calibrationFactor);
  const shouldCompact = Math.max(initialEstimate, input.session.contextTokens) >= thresholdTokens;
  let retainedRecords = afterCheckpoint;
  let dropped: ContextEntry[] = [];
  let checkpoint = prior.checkpoint;
  if (shouldCompact && afterCheckpoint.length > 1) {
    const preferredRecent = chooseRecentRecords(afterCheckpoint, Math.floor(thresholdTokens * 0.35));
    const openToolRecords = unmatchedToolRecords(afterCheckpoint, Number.MAX_SAFE_INTEGER);
    const openCallKeys = new Set(openToolRecords.flatMap((record) => record.toolCalls?.map((call) => call.callId) ?? []));
    const pairedOpenResults = afterCheckpoint.filter((record) => record.kind === "tool_result" && record.toolCallKey && openCallKeys.has(record.toolCallKey));
    const protectedKeys = new Set([...preferredRecent, ...openToolRecords, ...pairedOpenResults].map((record) => record.recordId));
    const earliestOpenSequence = openToolRecords.length > 0 ? Math.min(...openToolRecords.map((record) => record.sequence)) : undefined;
    dropped = afterCheckpoint.filter((record) => !protectedKeys.has(record.recordId) && (earliestOpenSequence === undefined || record.sequence < earliestOpenSequence));
    if (dropped.length > 0) {
      checkpoint = buildCheckpoint(input.session, dropped, prior.checkpoint, input.semanticSummary);
      const droppedKeys = new Set(dropped.map((record) => record.recordId));
      retainedRecords = uniqueRecords(afterCheckpoint.filter((record) => !droppedKeys.has(record.recordId)));
    }
  }

  // Root guidance is frozen until compaction. A successful compaction starts a new frozen prefix.
  const sessionEnvelopeText = dropped.length > 0 ? stableEnvelope(input, startupGuidance) : frozenEnvelope;
  const checkpointMessage = checkpoint ? renderCheckpoint(checkpoint) : undefined;
  const historyMessages = protocolSafeModelMessages(retainedRecords);
  const messages: ModelMessage[] = [
    { role: "system", text: blueprint.text },
    { role: "user", text: sessionEnvelopeText },
    ...(checkpointMessage ? [{ role: "user" as const, text: checkpointMessage }] : []),
    ...historyMessages,
    ...(recoveryEnvelope ? [{ role: "user" as const, text: recoveryEnvelope }] : []),
    ...(modeEnvelope ? [{ role: "user" as const, text: modeEnvelope }] : []),
    ...(input.latestUserInRecords ? [] : [{ role: "user" as const, text: input.prompt }])
  ];
  const updateRecords = retainedRecords.filter((record) => record.kind === "context_update");
  const trajectoryRecords = retainedRecords.filter((record) => record.kind !== "context_update");
  const memoryIndexText = envelopeSection(sessionEnvelopeText, "memory_index");
  const capabilityIndexText = [
    envelopeSection(sessionEnvelopeText, "capability_index"),
    envelopeSection(sessionEnvelopeText, "skill_index")
  ].filter(Boolean).join("\n");
  const envelopeSource = dropped.length > 0 ? "generated_after_compaction" : existingEnvelope?.recordId ?? "generated";
  const sections: ContextSectionStats[] = [
    metric("tools", "ModelRequest.tools", toolText, "stable", { role: "top_level", survivesCompaction: true }),
    metric("prompt_kernel", blueprint.version, blueprint.text, "stable", { role: "system", survivesCompaction: true }),
    metric("stable_session", envelopeSource, envelopeWithoutIndexes(sessionEnvelopeText), "session_stable", { role: "user", survivesCompaction: true }),
    metric("memory_index", "StableSessionEnvelope.memory_index", memoryIndexText, "session_stable", { role: "user", survivesCompaction: true }),
    metric("capability_index", "StableSessionEnvelope.capability_index", capabilityIndexText, "session_stable", { role: "user", survivesCompaction: true }),
    ...(checkpointMessage ? [metric("checkpoint", "Checkpoint", checkpointMessage, "compaction_stable", { role: "user", survivesCompaction: true })] : []),
    metric("recent_history", `${trajectoryRecords.length} records`, protocolSafeModelMessages(trajectoryRecords)
      .map((message) => JSON.stringify(message))
      .join("\n"), "dynamic", { survivesCompaction: false }),
    ...updateRecords.map((record) => metric("context_update", String(record.metadata?.sourceFile ?? record.recordId), record.text ?? "", "dynamic", {
      loadingReason: String(record.metadata?.activationReason ?? "lazy activation"),
      recordId: record.recordId,
      revisionHash: String(record.metadata?.revisionHash ?? ""),
      role: "user",
      survivesCompaction: false,
      trust: String(record.metadata?.trust ?? "")
    })),
    ...(recoveryEnvelope ? [metric("recovery_capsule", "Runtime resume evidence", recoveryEnvelope, "dynamic", { role: "user", survivesCompaction: false })] : []),
    ...(modeEnvelope ? [metric("mode_context", "Runtime mode", modeEnvelope, "dynamic", { role: "user", survivesCompaction: true })] : []),
    metric("latest_user", "User", input.latestUserInRecords ? "" : input.prompt, "dynamic", { role: "user", survivesCompaction: true })
  ];
  const rawEstimatedInputTokens = estimateProviderRequestTokens(messages, input.tools);
  const estimatedInputTokens = Math.ceil(rawEstimatedInputTokens * calibrationFactor);
  const prefixHash = createHash("sha256").update([toolText, blueprint.hash, sessionEnvelopeText, checkpointMessage ?? ""].join("\n")).digest("hex");
  const telemetry: ContextStats = {
    blueprintHash: blueprint.hash,
    blueprintVersion: blueprint.version,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    compactAfterTokens: dropped.length > 0 ? estimatedInputTokens : undefined,
    compactBeforeTokens: dropped.length > 0 ? initialEstimate : undefined,
    compactThresholdTokens: thresholdTokens,
    createdAt: new Date().toISOString(),
    runId: input.runId,
    droppedRecordCount: dropped.length,
    droppedRecords: dropped.map((record) => ({ recordId: record.recordId, reason: "superseded_by_checkpoint" })),
    effectiveInputBudgetTokens,
    estimatedInputTokens,
    model: input.model,
    prefixHash,
    protocolReserveTokens: context.protocolReserveTokens,
    providerContextWindowTokens: windowTokens,
    recordFingerprint: contextFingerprint(retainedRecords),
    requestedMaxOutputTokens,
    rawEstimatedInputTokens,
    retainedRecordCount: retainedRecords.length,
    retainedRecordKeys: retainedRecords.map((record) => record.recordId),
    safetyMarginTokens: context.safetyMarginTokens,
    sections,
    sessionId: input.session.sessionId,
    metricId: `context_telemetry_${randomUUID()}`,
    tokenCalibrationFactor: calibrationFactor,
    truncationEvents: input.records.filter((record) => record.wasTruncated).slice(-100).map((record) => ({
      artifactRef: record.artifactRef,
      originalBytes: Number(record.metadata?.originalBytes) || undefined,
      recordId: record.recordId,
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
      recordId: record.recordId,
      source: String(record.metadata?.sourceFile ?? "")
    })),
    ...telemetry.truncationEvents.map((event) => ({
      createdAt: new Date().toISOString(),
      kind: "evidence_truncated" as const,
      label: event.toolName ?? event.recordId,
      recordId: event.recordId,
      source: event.artifactRef
    }))
  ];
  const refreshEnvelope = !existingEnvelope || dropped.length > 0;
  return {
    checkpoint,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    contextTokens: estimatedInputTokens,
    debugSnapshot: {
      blueprint: { hash: blueprint.hash, version: blueprint.version },
      guidanceSources: startupGuidance.map(({ guidanceId, origin, revisionHash, sourceFile, trust }) => ({ guidanceId, origin, revisionHash, sourceFile, trust })),
      layout: sections,
      messageRoles: messages.map((message) => message.role),
      prefixHash,
      recordIds: retainedRecords.map((record) => record.recordId),
      tools: input.tools.map((tool) => tool.name)
    },
    droppedRecordCount: dropped.length,
    droppedRecords: dropped,
    effectiveInputBudgetTokens,
    instructions: startupGuidance,
    messages,
    recoveryRecord: recoveryEnvelope ? {
      runId: input.runId,
      kind: "recovery_capsule",
      metadata: { failureType: resume?.failureType },
      sessionId: input.session.sessionId,
      source: "runtime",
      text: recoveryEnvelope
    } : undefined,
    requestedMaxOutputTokens,
    retainedRecords,
    sessionEnvelopeRecord: refreshEnvelope ? {
      runId: input.runId,
      kind: "session_context",
      metadata: { guidanceKeys: startupGuidance.map((activity) => activity.instructionKey), prefixHash },
      sessionId: input.session.sessionId,
      source: "runtime",
      text: sessionEnvelopeText
    } : undefined,
    telemetry,
    thresholdTokens,
    windowTokens
  };
}

export function estimateProviderRequestTokens(messages: ModelMessage[], tools: ToolSpec[]): number {
  return estimateTokens(JSON.stringify({ messages, tools }));
}

export function findNewPathInstructions(
  projectRoot: string,
  activePaths: string[],
  knownInstructionKeys: Set<string>,
  rules: RuleSource = emptyRuleSource
): ResolvedRule[] {
  return rules.resolve({ activePaths, phase: "path_access", projectRoot })
    .filter((instruction) => !knownInstructionKeys.has(instruction.instructionKey));
}

export function renderAdditionalInstructions(instructions: ResolvedRule[], rules: RuleSource = emptyRuleSource): ModelMessage | undefined {
  const text = rules.render(instructions, "update");
  return text ? { role: "user", text } : undefined;
}

export function contextUpdateRecord(
  sessionId: string,
  runId: string,
  instructions: ResolvedRule[],
  trigger: "read_result" | "mutation_preflight",
  rules: RuleSource = emptyRuleSource
): ContextInput | undefined {
  const raw = rules.render(instructions, "update");
  if (!raw) return undefined;
  const text = systemReminder("guidance", raw);
  return {
    runId,
    kind: "context_update",
    metadata: {
      activationReason: trigger,
      guidanceKeys: instructions.map((activity) => activity.instructionKey),
      label: instructions.length === 1 ? instructions[0].sourceFile : `${instructions.length} guidance activities`,
      revisionHash: instructions.map((activity) => activity.revisionHash).join(","),
      sourceFile: instructions.map((activity) => activity.sourceFile).join(","),
      trust: instructions.map((activity) => activity.trust).join(","),
      updateKind: "path_guidance"
    },
    sessionId,
    source: "runtime",
    text
  };
}

export function previousRunForRecovery(session: Session): Run | undefined {
  return [...session.runs].reverse().find((run) => run.resume);
}
