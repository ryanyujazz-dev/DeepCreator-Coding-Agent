export type ToolResult = {
  command?: string;
  contextUpdate?: {
    metadata: Record<string, unknown>;
    text: string;
  };
  exitCode?: number;
  mutatedWorkspace: boolean;
  output: string;
  timedOut?: boolean;
};

export type ToolProgress = {
  text: string;
};

export type BaselineFile = {
  exists: boolean;
  snapshotPath?: string;
};

export type Baseline = {
  available: boolean;
  files: Map<string, BaselineFile>;
  snapshotDirectory: string;
};
