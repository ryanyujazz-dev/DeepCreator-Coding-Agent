import {
  ArchiveSessionsResponse,
  ContextObserverResponse,
  InteractionResponse,
  OkResponse,
  RuntimeBalance,
  RuntimeConfig,
  RuntimeFilePreview,
  RuntimeWorkspace,
  SessionResponse,
  SessionsResponse,
  WorkspaceResponse
} from "../contracts/api";
import { EventStream, Session, SessionSummary } from "../contracts/runtime";
import { EvalCasesResponse, EvalRunRecord, EvalRunResponse, EvalRunsResponse } from "../contracts/evals";
import { eventSchema } from "./event";

type RecordValue = Record<string, unknown>;

export class ContractViolationError extends Error {
  constructor(readonly path: string, expectation: string) {
    super(`Runtime contract violation at ${path}: expected ${expectation}.`);
    this.name = "ContractViolationError";
  }
}

function record(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractViolationError(path, "object");
  return value as RecordValue;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractViolationError(path, "string");
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ContractViolationError(path, "finite number");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractViolationError(path, "boolean");
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractViolationError(path, "array");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function sessionSummary(value: unknown, path: string): SessionSummary {
  const item = record(value, path);
  string(item.sessionId, `${path}.sessionId`);
  string(item.title, `${path}.title`);
  string(item.model, `${path}.model`);
  string(item.projectRoot, `${path}.projectRoot`);
  string(item.workspaceKind, `${path}.workspaceKind`);
  string(item.createdAt, `${path}.createdAt`);
  string(item.updatedAt, `${path}.updatedAt`);
  number(item.runCount, `${path}.runCount`);
  boolean(item.active, `${path}.active`);
  if (item.pinned !== undefined) boolean(item.pinned, `${path}.pinned`);
  return item as SessionSummary;
}

function session(value: unknown, path: string): Session {
  const item = record(value, path);
  string(item.sessionId, `${path}.sessionId`);
  string(item.title, `${path}.title`);
  string(item.model, `${path}.model`);
  string(item.mode, `${path}.mode`);
  string(item.planEntry, `${path}.planEntry`);
  string(item.projectRoot, `${path}.projectRoot`);
  string(item.workspaceKind, `${path}.workspaceKind`);
  string(item.createdAt, `${path}.createdAt`);
  string(item.updatedAt, `${path}.updatedAt`);
  number(item.contextTokens, `${path}.contextTokens`);
  number(item.contextWindowTokens, `${path}.contextWindowTokens`);
  number(item.compactThresholdTokens, `${path}.compactThresholdTokens`);
  number(item.lastOffset, `${path}.lastOffset`);
  array(item.runIds, `${path}.runIds`).forEach((entry, index) => string(entry, `${path}.runIds[${index}]`));
  const runs = array(item.runs, `${path}.runs`);
  array(item.plans, `${path}.plans`);
  array(item.questions, `${path}.questions`);
  const followUps = item.followUps === undefined ? [] : array(item.followUps, `${path}.followUps`);
  item.followUps = followUps;
  followUps.forEach((entry, index) => {
    const followUp = record(entry, `${path}.followUps[${index}]`);
    string(followUp.followUpId, `${path}.followUps[${index}].followUpId`);
    string(followUp.prompt, `${path}.followUps[${index}].prompt`);
    string(followUp.createdAt, `${path}.followUps[${index}].createdAt`);
    string(followUp.model, `${path}.followUps[${index}].model`);
    string(followUp.accessMode, `${path}.followUps[${index}].accessMode`);
    string(followUp.mode, `${path}.followUps[${index}].mode`);
    string(followUp.planEntry, `${path}.followUps[${index}].planEntry`);
  });
  array(item.grants, `${path}.grants`);
  runs.forEach((entry, index) => {
    const run = record(entry, `${path}.runs[${index}]`);
    string(run.runId, `${path}.runs[${index}].runId`);
    string(run.sessionId, `${path}.runs[${index}].sessionId`);
    string(run.status, `${path}.runs[${index}].status`);
    string(run.prompt, `${path}.runs[${index}].prompt`);
    string(run.model, `${path}.runs[${index}].model`);
    string(run.mode, `${path}.runs[${index}].mode`);
    string(run.startedAt, `${path}.runs[${index}].startedAt`);
    string(run.answer, `${path}.runs[${index}].answer`);
    number(run.lastOffset, `${path}.runs[${index}].lastOffset`);
    array(run.activities, `${path}.runs[${index}].activities`);
    array(run.tasks, `${path}.runs[${index}].tasks`);
    array(run.approvals, `${path}.runs[${index}].approvals`);
    record(run.changes, `${path}.runs[${index}].changes`);
  });
  return item as Session;
}

function contextStats(value: unknown, path: string): void {
  const item = record(value, path);
  string(item.metricId, `${path}.metricId`);
  string(item.sessionId, `${path}.sessionId`);
  string(item.runId, `${path}.runId`);
  string(item.createdAt, `${path}.createdAt`);
  number(item.estimatedInputTokens, `${path}.estimatedInputTokens`);
  boolean(item.compacted, `${path}.compacted`);
  array(item.sections, `${path}.sections`);
}

export function decodeRuntimeConfig(value: unknown): RuntimeConfig {
  const item = record(value, "$config");
  number(item.compactThresholdTokens, "$config.compactThresholdTokens");
  number(item.contextWindowTokens, "$config.contextWindowTokens");
  number(item.effectiveInputBudgetTokens, "$config.effectiveInputBudgetTokens");
  number(item.requestedMaxOutputTokens, "$config.requestedMaxOutputTokens");
  string(item.defaultModel, "$config.defaultModel");
  boolean(item.hasApiKey, "$config.hasApiKey");
  string(item.eventContract, "$config.eventContract");
  if (item.evalsEnabled !== undefined) boolean(item.evalsEnabled, "$config.evalsEnabled");
  string(item.planEntry, "$config.planEntry");
  string(item.workspaceRoot, "$config.workspaceRoot");
  array(item.models, "$config.models").forEach((entry, index) => {
    const model = record(entry, `$config.models[${index}]`);
    string(model.id, `$config.models[${index}].id`);
    string(model.label, `$config.models[${index}].label`);
    string(model.provider, `$config.models[${index}].provider`);
    string(model.description, `$config.models[${index}].description`);
  });
  if (item.contextPreview !== undefined) contextStats(item.contextPreview, "$config.contextPreview");
  return item as RuntimeConfig;
}

export function decodeRuntimeBalance(value: unknown): RuntimeBalance {
  const item = record(value, "$balance");
  boolean(item.isAvailable, "$balance.isAvailable");
  array(item.balanceInfos, "$balance.balanceInfos").forEach((entry, index) => {
    const balance = record(entry, `$balance.balanceInfos[${index}]`);
    string(balance.currency, `$balance.balanceInfos[${index}].currency`);
    number(balance.totalBalance, `$balance.balanceInfos[${index}].totalBalance`);
    number(balance.grantedBalance, `$balance.balanceInfos[${index}].grantedBalance`);
    number(balance.toppedUpBalance, `$balance.balanceInfos[${index}].toppedUpBalance`);
  });
  return item as RuntimeBalance;
}

function evalRunRecord(value: unknown, path: string): EvalRunRecord {
  const item = record(value, path);
  number(item.attempt, `${path}.attempt`);
  string(item.caseId, `${path}.caseId`);
  string(item.createdAt, `${path}.createdAt`);
  string(item.evalRunId, `${path}.evalRunId`);
  string(item.experimentId, `${path}.experimentId`);
  string(item.judge, `${path}.judge`);
  string(item.model, `${path}.model`);
  string(item.promptVersion, `${path}.promptVersion`);
  string(item.stage, `${path}.stage`);
  optionalString(item.error, `${path}.error`);
  optionalString(item.finishedAt, `${path}.finishedAt`);
  optionalString(item.judgeModel, `${path}.judgeModel`);
  optionalString(item.runId, `${path}.runId`);
  optionalString(item.sessionId, `${path}.sessionId`);
  if (item.result !== undefined) record(item.result, `${path}.result`);
  return item as EvalRunRecord;
}

export function decodeEvalCasesResponse(value: unknown): EvalCasesResponse {
  const item = record(value, "$evalCases");
  const cases = array(item.cases, "$evalCases.cases");
  cases.forEach((value, index) => {
    const candidate = record(value, `$evalCases.cases[${index}]`);
    string(candidate.caseId, `$evalCases.cases[${index}].caseId`);
    string(candidate.title, `$evalCases.cases[${index}].title`);
    string(candidate.scenario, `$evalCases.cases[${index}].scenario`);
    string(candidate.status, `$evalCases.cases[${index}].status`);
    string(candidate.userRequest, `$evalCases.cases[${index}].userRequest`);
    string(candidate.initialMode, `$evalCases.cases[${index}].initialMode`);
    number(candidate.idealStepCount, `$evalCases.cases[${index}].idealStepCount`);
    array(candidate.allowedTools, `$evalCases.cases[${index}].allowedTools`);
  });
  return item as EvalCasesResponse;
}

export function decodeEvalRunsResponse(value: unknown): EvalRunsResponse {
  const item = record(value, "$evalRuns");
  array(item.runs, "$evalRuns.runs").forEach((run, index) => evalRunRecord(run, `$evalRuns.runs[${index}]`));
  return item as EvalRunsResponse;
}

export function decodeEvalRunResponse(value: unknown): EvalRunResponse {
  const item = record(value, "$evalRun");
  evalRunRecord(item.run, "$evalRun.run");
  return item as EvalRunResponse;
}

export function decodeSessionsResponse(value: unknown): SessionsResponse {
  const item = record(value, "$sessions");
  array(item.sessions, "$sessions.sessions").forEach((entry, index) => sessionSummary(entry, `$sessions.sessions[${index}]`));
  return item as SessionsResponse;
}

export function decodeSessionResponse(value: unknown): SessionResponse {
  const item = record(value, "$session");
  session(item.session, "$session.session");
  return item as SessionResponse;
}

export function decodeWorkspaceResponse(value: unknown): WorkspaceResponse {
  const item = record(value, "$workspace");
  const workspace = record(item.workspace, "$workspace.workspace");
  optionalString(workspace.branch, "$workspace.workspace.branch");
  number(workspace.dirtyFiles, "$workspace.workspace.dirtyFiles");
  boolean(workspace.exists, "$workspace.workspace.exists");
  boolean(workspace.git, "$workspace.workspace.git");
  string(workspace.name, "$workspace.workspace.name");
  string(workspace.projectRoot, "$workspace.workspace.projectRoot");
  return item as WorkspaceResponse;
}

export function decodeContextObserverResponse(value: unknown): ContextObserverResponse {
  const item = record(value, "$contextObserver");
  const observer = record(item.observer, "$contextObserver.observer");
  string(observer.sessionId, "$contextObserver.observer.sessionId");
  number(observer.memoryFactCount, "$contextObserver.observer.memoryFactCount");
  array(observer.recent, "$contextObserver.observer.recent").forEach((entry, index) => contextStats(entry, `$contextObserver.observer.recent[${index}]`));
  array(observer.updates, "$contextObserver.observer.updates");
  if (observer.latest !== undefined) contextStats(observer.latest, "$contextObserver.observer.latest");
  return item as ContextObserverResponse;
}

export function decodeRuntimeFilePreview(value: unknown): RuntimeFilePreview {
  const item = record(value, "$file");
  string(item.content, "$file.content");
  string(item.path, "$file.path");
  string(item.projectRoot, "$file.projectRoot");
  boolean(item.truncated, "$file.truncated");
  return item as RuntimeFilePreview;
}

export function decodeOkResponse(value: unknown): OkResponse {
  const item = record(value, "$ok");
  boolean(item.ok, "$ok.ok");
  if (item.settled !== undefined) boolean(item.settled, "$ok.settled");
  return item as OkResponse;
}

export function decodeArchiveSessionsResponse(value: unknown): ArchiveSessionsResponse {
  const item = record(value, "$archive");
  number(item.archived, "$archive.archived");
  return item as ArchiveSessionsResponse;
}

export function decodeInteractionResponse(value: unknown): InteractionResponse {
  const item = record(value, "$interaction");
  boolean(item.idempotent, "$interaction.idempotent");
  session(item.session, "$interaction.session");
  return item as InteractionResponse;
}

export function decodeEventStream(value: unknown): EventStream {
  const item = record(value, "$stream");
  const kind = string(item.kind, "$stream.kind");
  string(item.sessionId, "$stream.sessionId");
  if (kind === "heartbeat") {
    number(item.offset, "$stream.offset");
    return item as EventStream;
  }
  if (kind !== "events") throw new ContractViolationError("$stream.kind", '"events" or "heartbeat"');
  const events = array(item.events, "$stream.events").map((event) => eventSchema.parse(event));
  return { events, kind: "events", sessionId: item.sessionId as string };
}

export type RuntimeDecoder<T> = (value: unknown) => T;

export function workspaceFrom(response: WorkspaceResponse): RuntimeWorkspace {
  return response.workspace;
}
