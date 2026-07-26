import { ContextStats } from "../../shared/contracts/context";
import { CapabilitySource } from "../../shared/contracts/capability";
import { ToolSpec } from "../../shared/contracts/provider";
import { RuleSource } from "../../shared/contracts/rules";
import { Session } from "../../shared/contracts/runtime";
import {
  ContextConfig,
  getCompactThresholdTokens,
  getContextWindowTokens,
  prepareSessionContext
} from "./contextBuilder";
import { ContextPort, MemoryPort, MetricPort, SessionPort } from "./runtimeRepo";
import { SystemPort } from "./systemPort";
import { AppError } from "./appError";

type ContextQueryPorts = ContextPort & MemoryPort & MetricPort & SessionPort;

export class ContextQueryError extends AppError {
  constructor(message: string) {
    super(message, "not_found");
    this.name = "ContextQueryError";
  }
}

export class ContextQueries {
  constructor(private readonly deps: {
    capabilities: CapabilitySource;
    context: ContextConfig;
    defaultModel: string;
    rules: RuleSource;
    store: ContextQueryPorts;
    system: SystemPort;
    tools: ToolSpec[];
    workspaceRoot: string;
  }) {}

  preview(): ContextStats {
    const now = this.deps.system.now();
    const session: Session = {
      accessMode: "request_approval",
      compactThresholdTokens: getCompactThresholdTokens(
        this.deps.context.windowTokens,
        this.deps.context.maxOutputTokens,
        this.deps.context
      ),
      contextTokens: 0,
      contextWindowTokens: getContextWindowTokens(this.deps.context),
      createdAt: now,
      grants: [],
      lastOffset: 0,
      mode: "work",
      model: this.deps.defaultModel,
      planEntry: "suggest",
      plans: [],
      projectRoot: this.deps.workspaceRoot,
      questions: [],
      runIds: [],
      runs: [],
      sessionId: "context_preview",
      title: "Context preview",
      updatedAt: now,
      workspaceKind: "project"
    };
    return this.prepare(session, [], "context_preview");
  }

  telemetry(sessionId: string): ContextStats[] {
    if (!this.deps.store.getSession(sessionId)) throw new ContextQueryError("session not found");
    return this.deps.store.readMetrics(sessionId);
  }

  observer(sessionId: string) {
    const session = this.deps.store.getSession(sessionId);
    if (!session) throw new ContextQueryError("session not found");
    const telemetry = this.deps.store.readMetrics(sessionId);
    const records = this.deps.store.readContextEntries(sessionId);
    const preview = telemetry.length === 0 ? this.prepare(session, records, "context_preview") : undefined;
    return {
      latest: telemetry.at(-1) ?? preview,
      memoryFactCount: this.deps.store.readMemories(session.projectRoot).length,
      recent: telemetry.slice(-20),
      sessionId: session.sessionId,
      updates: records.filter((record) => record.kind === "context_update").slice(-50).map((record) => ({
        createdAt: record.createdAt,
        kind: record.metadata?.updateKind ?? "context_update",
        label: record.metadata?.label ?? "Context update",
        loadingReason: record.metadata?.activationReason,
        recordId: record.recordId,
        revisionHash: record.metadata?.revisionHash,
        source: record.metadata?.sourceFile,
        survivesCompaction: false,
        trust: record.metadata?.trust
      }))
    };
  }

  private prepare(session: Session, records: ReturnType<ContextPort["readContextEntries"]>, runId: string): ContextStats {
    return prepareSessionContext({
      capabilityIndex: this.deps.capabilities.digest(session.projectRoot),
      context: this.deps.context,
      memoryIndex: this.deps.store.memoryDigest(session.projectRoot),
      model: session.model,
      projectRoot: session.projectRoot,
      prompt: "",
      providerContextWindowTokens: getContextWindowTokens(this.deps.context),
      records,
      rules: this.deps.rules,
      runId,
      session,
      system: this.deps.system,
      tokenCalibrationFactor: this.deps.store.readCalibration(session.model),
      tools: this.deps.tools
    }).telemetry;
  }
}
