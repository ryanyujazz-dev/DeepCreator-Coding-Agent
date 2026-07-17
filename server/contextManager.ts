import { createHash, randomUUID } from "node:crypto";
import { CycleView, RecoveryCapsule, WorkspaceSessionView } from "../shared/runtimeTypes";
import {
  ContextCheckpoint,
  ContextRecord,
  ContextSectionMetric,
  ContextTelemetry,
  checkpointText,
  contextRecordFingerprint,
  providerMessageFromRecord
} from "./contextRecords";
import { renderInstructions, resolveInstructions, ResolvedInstruction } from "./instructionResolver";
import { promptBlueprintRegistry } from "./promptBlueprintRegistry";
import { ProviderMessage, ToolDefinition } from "./providerTypes";

const DEFAULT_WINDOW = 1_000_000;
const DEFAULT_RATIO = 0.85;
const DEFAULT_OUTPUT_RESERVE = 64_000;
const DEFAULT_SAFETY_MARGIN = 16_000;

export type PreparedContext = {
  messages: ProviderMessage[];
  instructions: ResolvedInstruction[];
  checkpoint?: ContextCheckpoint;
  compacted: boolean;
  compactedRecordCount: number;
  contextTokenEstimate: number;
  retainedRecords: ContextRecord[];
  droppedRecordCount: number;
  thresholdTokens: number;
  windowTokens: number;
  runtimeContext?: string;
  telemetry: ContextTelemetry;
  debugSnapshot: Record<string, unknown>;
};

type PrepareContextInput = {
  session: WorkspaceSessionView;
  records: ContextRecord[];
  currentCycleKey: string;
  prompt: string;
  model: string;
  projectRoot: string;
  tools: ToolDefinition[];
  providerContextWindowTokens?: number;
  latestUserInRecords?: boolean;
};

export function getContextWindowTokens(): number {
  return Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? DEFAULT_WINDOW);
}

export function getEffectiveInputBudgetTokens(window = getContextWindowTokens()): number {
  const outputReserve = Number(process.env.DEEPSEEK_OUTPUT_RESERVE_TOKENS ?? DEFAULT_OUTPUT_RESERVE);
  const safetyMargin = Number(process.env.DEEPSEEK_CONTEXT_SAFETY_TOKENS ?? DEFAULT_SAFETY_MARGIN);
  return Math.max(1, window - outputReserve - safetyMargin);
}

export function getCompactThresholdTokens(window = getContextWindowTokens()): number {
  return Math.max(1, Math.floor(
    getEffectiveInputBudgetTokens(window) * Number(process.env.DEEPSEEK_COMPACT_TRIGGER_RATIO ?? DEFAULT_RATIO)
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

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？.!?])\s*|\n+/).map((value) => value.trim()).filter(Boolean);
}

function latestPlan(session: WorkspaceSessionView) {
  return [...session.cycles].reverse().find((cycle) => cycle.plan.length > 0)?.plan ?? [];
}

function buildCheckpoint(
  session: WorkspaceSessionView,
  dropped: ContextRecord[],
  previous?: ContextCheckpoint
): ContextCheckpoint {
  const humanTexts = dropped.filter((record) => record.kind === "human_text").map((record) => record.text ?? "");
  const agentTexts = dropped.filter((record) => record.kind === "agent_text").map((record) => record.text ?? "");
  const toolResults = dropped.filter((record) => record.kind === "tool_result");
  const plan = latestPlan(session);
  const authoritativePlan = plan.length > 0 ? plan : previous?.currentPlan ?? [];
  const pendingWork = authoritativePlan.filter((step) => step.state !== "completed").map((step) => step.label);
  const changedFiles = session.cycles.flatMap((cycle) => cycle.workspaceDelta.files.map((file) => file.path));
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
    changedFiles: unique([...(previous?.changedFiles ?? []), ...changedFiles]),
    compactedRecordCount: (previous?.compactedRecordCount ?? 0) + dropped.length,
    compactedThroughSequence: dropped.at(-1)?.sequence ?? previous?.compactedThroughSequence ?? 0,
    constraints: unique([
      ...(previous?.constraints ?? []),
      ...humanTexts.flatMap(sentences).filter((line) => /必须|不要|不得|不能|只需|只要|保持|注意|应该|需要/.test(line))
    ]),
    currentPlan: authoritativePlan,
    decisions: unique([
      ...(previous?.decisions ?? []),
      ...agentTexts.flatMap(sentences).filter((line) => /采用|决定|改为|实现为|方案|原因|根因/.test(line))
    ]),
    failures: unique(failures),
    inspectedFiles: unique([...(previous?.inspectedFiles ?? []), ...inspectedFiles]),
    nextActions: unique(pendingWork.length ? pendingWork : authoritativePlan.length > 0 ? [] : previous?.nextActions ?? []),
    objective: (previous?.objective || humanTexts.find(Boolean) || session.cycles[0]?.prompt || "继续当前项目任务").slice(0, 1_200),
    pendingWork: unique(authoritativePlan.length > 0 ? pendingWork : previous?.pendingWork ?? []),
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

function renderRuntimeContext(projectRoot: string, recovery?: RecoveryCapsule): string {
  const payload = {
    projectRoot,
    recovery: recovery ? {
      changedFiles: recovery.changedFiles,
      completedOperations: recovery.completedOperations,
      failure: { message: recovery.failureMessage, type: recovery.failureType },
      interruptedOperations: recovery.interruptedOperations,
      lastProgress: recovery.lastProgress,
      plan: recovery.plan
    } : undefined
  };
  return `Runtime 当前事实（不是新的用户要求）：\n${JSON.stringify(payload)}\n执行前核对工作区事实，不要重复已经完成的操作。`;
}

function metric(
  section: ContextSectionMetric["section"],
  source: string,
  text: string,
  cacheClass: ContextSectionMetric["cacheClass"]
): ContextSectionMetric {
  return { cacheClass, estimatedTokens: estimateTokens(text), section, source };
}

export function prepareSessionContext(input: PrepareContextInput): PreparedContext {
  const blueprint = promptBlueprintRegistry.compileSystem(input.model);
  const prior = latestCheckpoint(input.records);
  const afterCheckpoint = input.records.filter((record) =>
    record.kind !== "checkpoint" && record.sequence > (prior.checkpoint?.compactedThroughSequence ?? 0)
  );
  const activePaths = unique(input.records.map((record) => String(record.metadata?.target ?? "")), 200);
  const instructions = resolveInstructions({ activePaths, projectRoot: input.projectRoot });
  const instructionText = renderInstructions(instructions);
  const recovery = recoveryFor(input.session, input.prompt);
  const runtimeContext = renderRuntimeContext(input.projectRoot, recovery);
  const toolText = JSON.stringify(input.tools);
  const initialEstimate = [
    blueprint.text,
    instructionText,
    prior.checkpoint ? checkpointText(prior.checkpoint) : undefined,
    ...afterCheckpoint.map((record) => JSON.stringify(record)),
    runtimeContext,
    input.prompt,
    toolText
  ].filter(Boolean).reduce((total, text) => total + estimateTokens(String(text)), 0);
  const configuredWindow = input.session.contextWindowTokens || getContextWindowTokens();
  const windowTokens = input.providerContextWindowTokens
    ? Math.min(configuredWindow, input.providerContextWindowTokens)
    : configuredWindow;
  const providerAwareThreshold = getCompactThresholdTokens(windowTokens);
  const thresholdTokens = Math.min(
    input.session.compactThresholdTokens || providerAwareThreshold,
    providerAwareThreshold
  );
  const shouldCompact = Math.max(initialEstimate, input.session.contextTokenEstimate) >= thresholdTokens;
  let retainedRecords = afterCheckpoint;
  let dropped: ContextRecord[] = [];
  let checkpoint = prior.checkpoint;
  if (shouldCompact && afterCheckpoint.length > 1) {
    const preferredRecent = chooseRecentRecords(afterCheckpoint, Math.floor(thresholdTokens * 0.35));
    const openToolRecords = unmatchedToolRecords(afterCheckpoint, Number.MAX_SAFE_INTEGER);
    const earliestOpenSequence = openToolRecords.length > 0
      ? Math.min(...openToolRecords.map((record) => record.sequence))
      : undefined;
    const openCallKeys = new Set(openToolRecords.flatMap((record) => record.toolCalls?.map((call) => call.callKey) ?? []));
    const pairedOpenResults = afterCheckpoint.filter((record) =>
      record.kind === "tool_result" && record.toolCallKey && openCallKeys.has(record.toolCallKey)
    );
    const protectedKeys = new Set([...preferredRecent, ...openToolRecords, ...pairedOpenResults].map((record) => record.recordKey));
    dropped = afterCheckpoint.filter((record) =>
      !protectedKeys.has(record.recordKey) &&
      (earliestOpenSequence === undefined || record.sequence < earliestOpenSequence)
    );
    if (dropped.length > 0) {
      checkpoint = buildCheckpoint(input.session, dropped, prior.checkpoint);
      const droppedKeys = new Set(dropped.map((record) => record.recordKey));
      retainedRecords = uniqueRecords(afterCheckpoint.filter((record) => !droppedKeys.has(record.recordKey)));
    }
  }
  const checkpointMessage = checkpoint ? checkpointText(checkpoint) : undefined;
  const messages: ProviderMessage[] = [
    { role: "system", text: blueprint.text },
    ...(instructionText ? [{ role: "user" as const, text: instructionText }] : []),
    ...(checkpointMessage ? [{ role: "system" as const, text: checkpointMessage }] : []),
    ...retainedRecords.map(providerMessageFromRecord).filter((message): message is ProviderMessage => Boolean(message)),
    { role: "system", text: runtimeContext },
    ...(input.latestUserInRecords ? [] : [{ role: "user" as const, text: input.prompt }])
  ];
  const sections = [
    metric("tools", "ProviderRequest.tools", toolText, "stable"),
    metric("system", blueprint.version, blueprint.text, "stable"),
    ...(instructionText ? [metric("instructions", instructions.map((item) => item.sourcePath).join(","), instructionText, "session_stable")] : []),
    ...(checkpointMessage ? [metric("checkpoint", "ContextCheckpoint", checkpointMessage, "compaction_stable")] : []),
    metric("recent_history", `${retainedRecords.length} records`, retainedRecords.map((record) => JSON.stringify(record)).join("\n"), "dynamic"),
    metric("runtime_context", "Runtime", runtimeContext, "dynamic"),
    metric("latest_user", "User", input.latestUserInRecords ? "" : input.prompt, "dynamic")
  ];
  const estimatedInputTokens = sections.reduce((total, section) => total + section.estimatedTokens, 0);
  const prefixHash = createHash("sha256")
    .update([toolText, blueprint.hash, instructionText ?? "", checkpointMessage ?? ""].join("\n"))
    .digest("hex");
  const telemetry: ContextTelemetry = {
    blueprintHash: blueprint.hash,
    blueprintVersion: blueprint.version,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    compactAfterTokens: dropped.length > 0 ? estimatedInputTokens : undefined,
    compactBeforeTokens: dropped.length > 0 ? initialEstimate : undefined,
    createdAt: new Date().toISOString(),
    cycleKey: input.currentCycleKey,
    droppedRecordCount: dropped.length,
    droppedRecords: dropped.map((record) => ({ recordKey: record.recordKey, reason: "superseded_by_checkpoint" })),
    estimatedInputTokens,
    prefixHash,
    recordFingerprint: contextRecordFingerprint(retainedRecords),
    retainedRecordCount: retainedRecords.length,
    retainedRecordKeys: retainedRecords.map((record) => record.recordKey),
    sections,
    sessionKey: input.session.sessionKey,
    telemetryKey: `context_telemetry_${randomUUID()}`,
    truncationEvents: input.records.filter((record) => record.wasTruncated).slice(-100).map((record) => ({
      artifactRef: record.artifactRef,
      originalBytes: Number(record.metadata?.originalBytes) || undefined,
      recordKey: record.recordKey,
      retainedBytes: Number(record.metadata?.retainedBytes) || undefined,
      toolName: record.toolName
    }))
  };
  return {
    checkpoint,
    compacted: dropped.length > 0,
    compactedRecordCount: dropped.length,
    contextTokenEstimate: estimatedInputTokens,
    debugSnapshot: {
      blueprint: { hash: blueprint.hash, version: blueprint.version },
      instructionSources: instructions.map(({ hash, priority, reason, scope, sourcePath }) => ({ hash, priority, reason, scope, sourcePath })),
      layout: sections,
      messageRoles: messages.map((message) => message.role),
      prefixHash,
      recordKeys: retainedRecords.map((record) => record.recordKey),
      telemetry: {
        compactAfterTokens: telemetry.compactAfterTokens,
        compactBeforeTokens: telemetry.compactBeforeTokens,
        droppedRecords: telemetry.droppedRecords,
        truncationEvents: telemetry.truncationEvents
      },
      tools: input.tools.map((tool) => tool.name)
    },
    droppedRecordCount: dropped.length,
    instructions,
    messages,
    retainedRecords,
    runtimeContext,
    telemetry,
    thresholdTokens,
    windowTokens
  };
}

export function estimateProviderRequestTokens(messages: ProviderMessage[], tools: ToolDefinition[]): number {
  return estimateTokens(JSON.stringify({ messages, tools }));
}

function uniqueRecords(records: ContextRecord[]): ContextRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.recordKey)) return false;
    seen.add(record.recordKey);
    return true;
  }).sort((left, right) => left.sequence - right.sequence);
}

export function findNewPathInstructions(
  projectRoot: string,
  activePaths: string[],
  knownInstructionKeys: Set<string>
): ResolvedInstruction[] {
  return resolveInstructions({ activePaths, projectRoot })
    .filter((instruction) => !knownInstructionKeys.has(instruction.instructionKey));
}

export function renderAdditionalInstructions(instructions: ResolvedInstruction[]): ProviderMessage | undefined {
  const text = renderInstructions(instructions);
  return text ? { role: "user", text } : undefined;
}

export function previousCycleForRecovery(session: WorkspaceSessionView): CycleView | undefined {
  return [...session.cycles].reverse().find((cycle) => cycle.recovery);
}
