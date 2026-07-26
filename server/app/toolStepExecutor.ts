import { ToolCall } from "../../shared/contracts/provider";
import { ToolOutcome } from "./toolPipeline";

export type ToolStepResult = {
  call: ToolCall;
  outcome: ToolOutcome;
};

/**
 * Executes consecutive parallel-safe calls together while preserving serial calls as barriers.
 * Results are always returned in provider call-index order, independent of settlement order.
 */
export async function executeToolStep(input: {
  calls: ToolCall[];
  execute: (call: ToolCall) => Promise<ToolOutcome>;
  parallel: (toolName: string) => boolean;
}): Promise<ToolStepResult[]> {
  const outcomes = new Map<string, ToolOutcome>();
  let parallelBatch: ToolCall[] = [];
  const flushParallel = async () => {
    if (parallelBatch.length === 0) return;
    const batch = parallelBatch;
    parallelBatch = [];
    const settled = await Promise.all(batch.map(input.execute));
    batch.forEach((call, index) => outcomes.set(call.callId, settled[index]));
  };

  for (const call of input.calls) {
    if (input.parallel(call.name)) {
      parallelBatch.push(call);
      continue;
    }
    await flushParallel();
    outcomes.set(call.callId, await input.execute(call));
  }
  await flushParallel();

  return [...input.calls]
    .sort((left, right) => left.index - right.index)
    .map((call) => {
      const outcome = outcomes.get(call.callId);
      if (!outcome) throw new Error(`Tool call ${call.callId} did not produce an outcome.`);
      return { call, outcome };
    });
}
