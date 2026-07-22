import { ActivityKind, Changes, ToolState } from "../../shared/contracts/runtime";
import { ToolSpec } from "../../shared/contracts/provider";
import { Baseline, ToolProgress, ToolResult } from "../../shared/contracts/tool";

export interface ToolHost {
  readonly specs: ToolSpec[];
  capture(projectRoot: string): Promise<Baseline>;
  checkpoint(projectRoot: string, baseline: Baseline, target: string): Promise<void>;
  changes(projectRoot: string, baseline: Baseline): Promise<Changes>;
  close(baseline: Baseline): Promise<void>;
  execute(input: {
    activityId?: string;
    args: Record<string, unknown>;
    name: string;
    onCommandSettled?: (result: ToolResult) => void;
    onOutput?: (progress: ToolProgress) => void;
    projectRoot: string;
    runId?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<ToolResult>;
  has(name: string): boolean;
  kind(tool: ToolState): ActivityKind;
  names(): string[];
  parallel(name: string): boolean;
  prepare(input: {
    args: Record<string, unknown>;
    argumentsPreview: string;
    callId: string;
    modelStepId: string;
    name: string;
    output?: string;
    projectRoot: string;
    result?: ToolResult;
  }): ToolState;
  retain(baseline: Baseline): void;
  runningCommands(runId: string): Array<{ commandId: string; elapsedMs: number }>;
  stopCommands(runId: string): Promise<void>;
  summarizeArgs(name: string, args: Record<string, unknown>): string;
  summarizeResult(name: string, args: Record<string, unknown>, output: string): string;
  title(name: string): string;
}
