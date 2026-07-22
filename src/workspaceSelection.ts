import { ProjectRef } from "../shared/contracts/desktop";

export type DraftWorkspace =
  | { kind: "project"; projectRoot: string }
  | { kind: "scratch" };

export function projectDraftWorkspace(projectRoot: string): DraftWorkspace {
  return { kind: "project", projectRoot };
}

export function mostRecentProject(projects: ProjectRef[]): ProjectRef | undefined {
  return [...projects].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))[0];
}

export function defaultDraftWorkspace(input: {
  current?: { projectRoot: string; workspaceKind: "project" | "scratch" } | null;
  currentExists?: boolean;
  fallbackProjectRoot?: string;
  projects: ProjectRef[];
}): DraftWorkspace {
  if (input.current?.workspaceKind === "project" && input.currentExists !== false) {
    return projectDraftWorkspace(input.current.projectRoot);
  }
  const recent = mostRecentProject(input.projects);
  if (recent) return projectDraftWorkspace(recent.path);
  if (input.fallbackProjectRoot) return projectDraftWorkspace(input.fallbackProjectRoot);
  return { kind: "scratch" };
}
