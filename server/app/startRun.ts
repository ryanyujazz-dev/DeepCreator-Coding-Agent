import { AccessMode, Mode, PlanEntry, Run, Session, WorkspaceKind } from "../../shared/contracts/runtime";
import { ContextConfig, getCompactThresholdTokens, getContextWindowTokens } from "./contextBuilder";
import { RunLaunchPort } from "./runLauncher";
import { EventPort, SessionPort } from "./runtimeRepo";
import { SystemPort } from "./systemPort";
import { WorkspacePort } from "./workspacePort";
import { AppError } from "./appError";
import { accessExceeds, agentDefinition, stricterAccess } from "./agentDefinitions";
import { ModelProtocol } from "../../shared/contracts/provider";

export type StartRunInput = {
  accessMode?: AccessMode;
  mode?: Mode;
  model?: string;
  planEntry?: PlanEntry;
  projectRoot?: string;
  prompt: string;
  sessionId: string;
  workspaceKind?: WorkspaceKind;
  consumeFollowUpId?: string;
};

export type StartRunResult = { run: Run; session: Session };

export class StartRunError extends AppError {
  constructor(
    message: string,
    readonly kind: "invalid_input" | "conflict"
  ) {
    super(message, kind);
    this.name = "StartRunError";
  }
}

function explicitPlanMode(prompt: string): boolean {
  return /(?:先|只|请).{0,12}(?:规划|计划|设计方案|分析方案)|(?:不要|先别|暂不).{0,8}(?:修改|改代码|执行|实现)|plan\s+mode/i.test(prompt);
}

export class StartRun {
  constructor(private readonly deps: {
    context: ContextConfig;
    defaultModel: string;
    launcher: RunLaunchPort;
    protocolForModel?: (model: string) => ModelProtocol;
    store: EventPort & SessionPort;
    system: SystemPort;
    workspace: WorkspacePort;
    workspaceRoot: string;
  }) {}

  async execute(input: StartRunInput): Promise<StartRunResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new StartRunError("prompt is required", "invalid_input");
    let model = input.model ?? this.deps.defaultModel;
    let session = this.deps.store.getSession(input.sessionId);
    let projectRoot: string;

    if (session) {
      if (session.kind === "subagent" && session.agentId) {
        if (input.mode && input.mode !== "work") throw new StartRunError("Subagent tasks always run in work mode.", "conflict");
        if (input.model && input.model !== session.model) throw new StartRunError("A subagent model is fixed by its agent profile.", "conflict");
        const parent = session.parentSessionId ? this.deps.store.getSession(session.parentSessionId) : undefined;
        const maximum = stricterAccess(parent?.accessMode ?? "request_approval", agentDefinition(session.agentId).maxAccessMode);
        if (input.accessMode && accessExceeds(input.accessMode, maximum)) {
          throw new StartRunError("Subagent permission cannot exceed its parent or agent profile.", "conflict");
        }
        model = session.model;
      }
      if (input.workspaceKind && input.workspaceKind !== session.workspaceKind) {
        throw new StartRunError("This task is locked to its original workspace.", "conflict");
      }
      if (input.projectRoot && this.deps.workspace.canonicalize(input.projectRoot) !== this.deps.workspace.canonicalize(session.projectRoot)) {
        throw new StartRunError("This task is locked to its original project directory.", "conflict");
      }
      if (session.workspaceKind === "scratch" && input.projectRoot) {
        throw new StartRunError("Scratch tasks cannot switch to a project directory.", "conflict");
      }
      if (session.workspaceKind === "scratch") {
        const expectedRoot = await this.deps.workspace.ensureScratch(input.sessionId);
        if (this.deps.workspace.canonicalize(expectedRoot) !== this.deps.workspace.canonicalize(session.projectRoot)) {
          throw new StartRunError("Scratch workspace metadata is inconsistent.", "conflict");
        }
        projectRoot = expectedRoot;
      } else {
        projectRoot = session.projectRoot;
      }
    } else {
      const workspaceKind = input.workspaceKind ?? "project";
      if (workspaceKind === "scratch" && input.projectRoot) {
        throw new StartRunError("projectRoot is not allowed for a scratch workspace.", "invalid_input");
      }
      try {
        projectRoot = workspaceKind === "scratch"
          ? await this.deps.workspace.ensureScratch(input.sessionId)
          : await this.deps.workspace.resolveProjectRoot({
              explicitRoot: input.projectRoot,
              fallbackRoot: this.deps.workspaceRoot,
              prompt
            });
      } catch (error) {
        throw new StartRunError(error instanceof Error ? error.message : "Unable to prepare workspace.", "invalid_input");
      }
    }

    if (!session) {
      const mode = input.mode ?? (explicitPlanMode(prompt) ? "plan" : "work");
      session = this.deps.store.createSession({
        accessMode: input.accessMode ?? "request_approval",
        compactThresholdTokens: getCompactThresholdTokens(this.deps.context.windowTokens, this.deps.context.maxOutputTokens, this.deps.context),
        contextWindowTokens: getContextWindowTokens(this.deps.context),
        mode,
        model,
        planEntry: input.planEntry ?? "suggest",
        projectRoot,
        sessionId: input.sessionId,
        title: prompt.slice(0, 42) || "新任务",
        workspaceKind: input.workspaceKind ?? "project"
      });
    }
    if (input.planEntry && input.planEntry !== session.planEntry) {
      this.deps.store.append({ data: { planEntry: input.planEntry }, sessionId: input.sessionId, type: "session.updated" });
      session = this.deps.store.getSession(input.sessionId)!;
    }
    if (input.accessMode && input.accessMode !== session.accessMode) {
      this.deps.store.append({ data: { accessMode: input.accessMode }, sessionId: input.sessionId, type: "session.updated" });
      session = this.deps.store.getSession(input.sessionId)!;
    }
    if (session.runs.some((run) => ["running", "waiting", "queued"].includes(run.status))) {
      throw new StartRunError("session already has an active run", "conflict");
    }
    const requestedMode = input.mode ?? (explicitPlanMode(prompt) ? "plan" : session.mode);
    if (requestedMode !== session.mode) {
      this.deps.store.append({
        data: { mode: requestedMode, previousMode: session.mode, reason: "用户在发送请求时选择了工作模式。", source: "user" },
        sessionId: input.sessionId,
        type: "mode.changed"
      });
      session = this.deps.store.getSession(input.sessionId)!;
    }

    const runId = this.deps.system.createId("run");
    const protocol = this.deps.protocolForModel?.(model) ?? "chat";
    const started = {
      data: { mode: session.mode, model, prompt, protocol, startedAt: this.deps.system.now() },
      runId,
      sessionId: input.sessionId,
      type: "run.started" as const
    };
    if (input.consumeFollowUpId) {
      if (!session.followUps.some((item) => item.followUpId === input.consumeFollowUpId)) {
        throw new StartRunError("queued follow-up not found", "conflict");
      }
      this.deps.store.appendMany([
        { data: { followUpId: input.consumeFollowUpId }, sessionId: input.sessionId, type: "follow_up.removed" },
        started
      ]);
    } else {
      this.deps.store.append(started);
    }
    this.deps.launcher.launch({ model, projectRoot, prompt, protocol, runId, sessionId: input.sessionId });
    return {
      run: this.deps.store.getRun(runId)!,
      session: this.deps.store.getSession(input.sessionId)!
    };
  }
}
