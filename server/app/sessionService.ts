import { AccessMode, Mode, PlanEntry, Run, Session, SessionSummary } from "../../shared/contracts/runtime";
import { EventPort, SessionPort } from "./runtimeRepo";
import { AppError } from "./appError";
import { accessExceeds, agentDefinition, stricterAccess } from "./agentDefinitions";

export class SessionServiceError extends AppError {
  constructor(message: string, readonly kind: "invalid_input" | "not_found" | "conflict") {
    super(message, kind);
    this.name = "SessionServiceError";
  }
}

function hasActiveRun(session: Session): boolean {
  return session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued");
}

export class SessionService {
  constructor(private readonly store: EventPort & SessionPort) {}

  list(query = ""): SessionSummary[] {
    return this.store.listSessions(query).filter((session) => !session.sessionId.startsWith("eval_"));
  }

  get(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new SessionServiceError("session not found", "not_found");
    return session;
  }

  getRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new SessionServiceError("run not found", "not_found");
    return run;
  }

  updateSidebar(sessionId: string, input: { archived?: boolean; pinned?: boolean }): void {
    const session = this.get(sessionId);
    if (input.archived && hasActiveRun(session)) {
      throw new SessionServiceError("An active task cannot be archived.", "conflict");
    }
    this.store.updateSessionSidebar(sessionId, input);
  }

  archiveProject(projectRoot: string): number {
    const target = projectRoot.trim();
    if (!target) throw new SessionServiceError("projectRoot is required", "invalid_input");
    if (this.store.listSessions().some((session) => session.projectRoot === target && session.active)) {
      throw new SessionServiceError("The project still has active tasks.", "conflict");
    }
    return this.store.archiveProjectSessions(target);
  }

  changeAccessMode(sessionId: string, accessMode: AccessMode | undefined): Session {
    const session = this.get(sessionId);
    if (!accessMode || !["request_approval", "smart_approval", "full_access"].includes(accessMode)) {
      throw new SessionServiceError("invalid permission profile", "invalid_input");
    }
    if (session.kind === "subagent" && session.agentId) {
      const parent = session.parentSessionId ? this.store.getSession(session.parentSessionId) : undefined;
      const maximum = stricterAccess(parent?.accessMode ?? "request_approval", agentDefinition(session.agentId).maxAccessMode);
      if (accessExceeds(accessMode, maximum)) {
        throw new SessionServiceError("subagent permission cannot exceed its parent or agent profile", "conflict");
      }
    }
    this.store.append({ data: { accessMode }, sessionId: session.sessionId, type: "session.updated" });
    return this.get(session.sessionId);
  }

  changeMode(sessionId: string, input: { mode?: Mode; planEntry?: PlanEntry }): Session {
    let session = this.get(sessionId);
    if (hasActiveRun(session)) {
      throw new SessionServiceError("active run controls the current mode", "conflict");
    }
    if (input.planEntry && input.planEntry !== session.planEntry) {
      this.store.append({ data: { planEntry: input.planEntry }, sessionId: session.sessionId, type: "session.updated" });
      session = this.get(session.sessionId);
    }
    if (input.mode && input.mode !== session.mode) {
      this.store.append({
        data: { mode: input.mode, previousMode: session.mode, reason: "用户切换了工作模式。", source: "user" },
        sessionId: session.sessionId,
        type: "mode.changed"
      });
    }
    return this.get(session.sessionId);
  }
}
