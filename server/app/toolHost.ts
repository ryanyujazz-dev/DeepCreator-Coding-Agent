import { ActivityKind, Changes, ToolState } from "../../shared/contracts/runtime";
import { ToolSpec } from "../../shared/contracts/provider";
import { Baseline, ToolProgress, ToolResult } from "../../shared/contracts/tool";

export type PreparedToolState = ToolState & Required<Pick<ToolState, "detail" | "displayTarget" | "groupMode" | "importance">>;

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
  /** 预开占位元数据:模型流式输出 tool_call name 时(还无合法 args,不能 prepare),用它给 activity
   *  填一个粗略 ToolState(action/targetKind/effect),执行时 toolPipeline 复用分支 durableToolState(prepared) 覆盖为精确值。 */
  outline(name: string): { action: ToolState["action"]; effect: ToolState["effect"]; targetKind: ToolState["targetKind"] };
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
  }): PreparedToolState;
  retain(baseline: Baseline): void;
  runningCommands(runId: string): Array<{ commandId: string; elapsedMs: number }>;
  stopCommands(runId: string): Promise<void>;
  summarizeArgs(name: string, args: Record<string, unknown>): string;
  summarizeResult(name: string, args: Record<string, unknown>, output: string): string;
  title(name: string): string;
}
