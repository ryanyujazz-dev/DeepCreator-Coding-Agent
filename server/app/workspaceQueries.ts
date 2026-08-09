import { SessionPort } from "./runtimeRepo";
import { AppError } from "./appError";
import type { Changes } from "../../shared/contracts/runtime";

export type WorkspaceInfo = {
  branch?: string;
  branches?: string[];
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
  checkout(projectRoot: string, branch: string): Promise<void>;
  collectHeadChanges(projectRoot: string): Promise<Changes>;
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

  async changes(sessionId: string): Promise<Changes> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new WorkspaceQueryError("session not found", "not_found");
    return this.workspace.collectHeadChanges(session.projectRoot);
  }

  // 切换本地分支。先 describe 拿到本地分支白名单,只允许切到已知分支(杜绝任意 ref);
  // git checkout 失败(如脏工作区冲突)的 stderr 包成 invalid_input → 400,客户端可读提示。
  // 成功后回读 describe,返回切换后的最新 workspace(新当前分支 + 分支列表)。
  async checkout(sessionId: string, branch: string): Promise<WorkspaceInfo> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new WorkspaceQueryError("session not found", "not_found");
    const info = await this.workspace.describe(session.projectRoot);
    if (!info.git) throw new WorkspaceQueryError("非 Git 工作区,无法切换分支", "invalid_input");
    const allowed = info.branches ?? [];
    if (!allowed.includes(branch)) throw new WorkspaceQueryError(`未知分支: ${branch}`, "invalid_input");
    try {
      await this.workspace.checkout(session.projectRoot, branch);
    } catch (error) {
      throw new WorkspaceQueryError(error instanceof Error ? error.message : "切换分支失败", "invalid_input");
    }
    return this.workspace.describe(session.projectRoot);
  }
}
