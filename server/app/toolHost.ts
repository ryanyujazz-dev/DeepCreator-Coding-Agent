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
    args: Record<string, unknown>;
    name: string;
    onOutput?: (progress: ToolProgress) => void;
    projectRoot: string;
    signal?: AbortSignal;
  }): Promise<ToolResult>;
  has(name: string): boolean;
  kind(tool: ToolState): ActivityKind;
  names(): string[];
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
  summarizeArgs(name: string, args: Record<string, unknown>): string;
  summarizeResult(name: string, args: Record<string, unknown>, output: string): string;
  title(name: string): string;
}
