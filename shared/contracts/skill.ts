export type SkillPermission =
  | "workspace_read"
  | "workspace_write"
  | "workspace_delete"
  | "shell_execute"
  | "network_access"
  | "external_access"
  | "local_code_execution";

export type SkillOrigin = "builtin" | "global" | "project";
export type SkillInstallScope = "global" | "project";
export type SkillUpdateState = "current" | "available" | "checking" | "failed" | "unsupported";

export type SkillScriptManifest = {
  description: string;
  entry: string;
  permissions: SkillPermission[];
};

export type SkillManifest = {
  displayName: string;
  minDeepCreatorVersion: string;
  permissions: SkillPermission[];
  publisher: string;
  schemaVersion: 1;
  scripts?: Record<string, SkillScriptManifest>;
  version: string;
};

export type SkillInstallSource =
  | { kind: "local"; label: string }
  | { kind: "github"; repository: string; releaseUrl: string };

export type SkillSummary = {
  capabilityId: string;
  conflict?: string;
  description: string;
  displayName: string;
  enabled: boolean;
  legacy: boolean;
  locked: boolean;
  name: string;
  origin: SkillOrigin;
  permissions: SkillPermission[];
  publisher: string;
  revisionHash: string;
  source: string;
  trusted: boolean;
  updateState: SkillUpdateState;
  version: string;
};

export type SkillInstallPreview = {
  description: string;
  displayName: string;
  files: Array<{ path: string; size: number }>;
  minDeepCreatorVersion: string;
  name: string;
  permissions: SkillPermission[];
  previewId: string;
  publisher: string;
  revisionHash: string;
  scripts: Array<{ description: string; id: string; permissions: SkillPermission[] }>;
  source: SkillInstallSource;
  version: string;
};

export type SkillInstallInput = {
  previewId: string;
  projectRoot?: string;
  scope: SkillInstallScope;
  trusted: boolean;
};

export type SkillTargetInput = {
  name: string;
  projectRoot?: string;
  scope: SkillOrigin;
};
