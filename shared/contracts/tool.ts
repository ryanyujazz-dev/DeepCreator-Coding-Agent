export type ToolResult = {
  command?: string;
  commandActivityId?: string;
  commandId?: string;
  commandRunId?: string;
  commandSessionId?: string;
  commandState?: "running" | "completed" | "failed" | "cancelled";
  contextUpdate?: {
    metadata: Record<string, unknown>;
    text: string;
  };
  exitCode?: number;
  elapsedMs?: number;
  mutatedWorkspace: boolean;
  output: string;
  outputTruncated?: boolean;
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
  leases: number;
  released: boolean;
  snapshotDirectory: string;
};
