import { CapabilitySource } from "../../shared/contracts/capability";
import { ContextEntry } from "../../shared/contracts/context";
import { ModelMessage, Provider, ToolSpec } from "../../shared/contracts/provider";
import { RuleSource } from "../../shared/contracts/rules";
import {
  BuildInput,
  BuiltContext,
  ContextConfig,
  prepareSessionContext
} from "./contextBuilder";
import {
  ContextPort,
  EvidencePort,
  EventPort,
  MemoryPort,
  MetricPort,
  SessionPort
} from "./runtimeRepo";
import { SystemPort } from "./systemPort";

export type RuntimeContextPorts = ContextPort & EventPort & EvidencePort & MemoryPort & MetricPort & SessionPort;

export type RuntimeContextInput = {
  capabilities: CapabilitySource;
  context: ContextConfig;
  model: string;
  projectRoot: string;
  prompt: string;
  provider: Provider;
  runId: string;
  rules: RuleSource;
  sessionId: string;
  signal?: AbortSignal;
  store: RuntimeContextPorts;
  system: SystemPort;
};

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

export async function prepareRuntimeContext(
  input: RuntimeContextInput,
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
    system: input.system,
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
    // The deterministic checkpoint remains authoritative when semantic compression is unavailable.
    return prepared;
  }
}

export function persistAssistantRecord(
  input: Pick<RuntimeContextInput, "runId" | "sessionId" | "store">,
  message: ModelMessage
): ContextEntry | undefined {
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

export function persistPreparedContext(
  input: Pick<RuntimeContextInput, "runId" | "sessionId" | "store">,
  prepared: BuiltContext,
  lifecycle: {
    onCompactionFinished?: (handle: unknown, prepared: BuiltContext) => void;
    onCompactionStarted?: (prepared: BuiltContext) => unknown;
  } = {}
): void {
  if (prepared.sessionEnvelopeRecord) input.store.appendContextEntry(prepared.sessionEnvelopeRecord);
  if (prepared.recoveryRecord && !input.store.readContextEntries(input.sessionId).some((record) =>
    record.kind === "recovery_capsule" && record.runId === input.runId
  )) input.store.appendContextEntry(prepared.recoveryRecord);

  if (prepared.compacted) {
    const handle = lifecycle.onCompactionStarted?.(prepared);
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
      data: {
        compactSummary: prepared.checkpoint ? JSON.stringify(prepared.checkpoint) : undefined,
        contextTokens: prepared.contextTokens
      },
      sessionId: input.sessionId,
      type: "session.updated"
    });
    lifecycle.onCompactionFinished?.(handle, prepared);
  } else {
    const session = input.store.getSession(input.sessionId);
    input.store.append({
      data: { compactSummary: session?.compactSummary, contextTokens: prepared.contextTokens },
      sessionId: input.sessionId,
      type: "session.updated"
    });
  }
  input.store.recordMetric(prepared.telemetry);
  input.store.writeDebugSnapshot(input.sessionId, input.runId, prepared.debugSnapshot);
}
