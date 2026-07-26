import { SessionPort } from "./runtimeRepo";
import { AppError } from "./appError";

export type WorkspaceInfo = {
  branch?: string;
  dirtyFiles: number;
  exists: boolean;
  git: boolean;
  name: string;
  projectRoot: string;
};

export type WorkspaceFile = {
  content: string;
  path: string;
  projectRoot: string;
  truncated: boolean;
};

export interface WorkspaceQueryPort {
  describe(projectRoot: string): Promise<WorkspaceInfo>;
  readText(projectRoot: string, relativePath: string, maxChars: number): Promise<WorkspaceFile>;
}

export class WorkspaceQueryError extends AppError {
  constructor(message: string, readonly kind: "invalid_input" | "not_found") {
    super(message, kind);
    this.name = "WorkspaceQueryError";
  }
}

export class WorkspaceQueries {
  constructor(
    private readonly sessions: SessionPort,
    private readonly workspace: WorkspaceQueryPort
  ) {}

  async describe(sessionId: string): Promise<WorkspaceInfo> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new WorkspaceQueryError("session not found", "not_found");
    return this.workspace.describe(session.projectRoot);
  }

  async readFile(sessionId: string, relativePath: string | undefined): Promise<WorkspaceFile> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new WorkspaceQueryError("session not found", "not_found");
    const target = relativePath?.trim();
    if (!target) throw new WorkspaceQueryError("path is required", "invalid_input");
    try {
      return await this.workspace.readText(session.projectRoot, target, 400_000);
    } catch (error) {
      throw new WorkspaceQueryError(error instanceof Error ? error.message : "file not found", "not_found");
    }
  }
}
