import { Plan } from "../contracts/runtime";

export type EvalPlanResolution = {
  comments?: string;
  decision: "continue_planning" | "start_work";
  plan: Plan;
};

export function resolveEvalPlanInteraction(
  plans: readonly Plan[],
  runId: string,
  continuePlanningOnce?: string
): EvalPlanResolution | undefined {
  const plan = [...plans].reverse().find((candidate) => candidate.runId === runId && candidate.status === "proposed");
  if (!plan) return undefined;
  const shouldContinuePlanning = Boolean(continuePlanningOnce)
    && !plans.some((candidate) => candidate.runId === runId && candidate.status === "rejected");
  return shouldContinuePlanning
    ? { comments: continuePlanningOnce, decision: "continue_planning", plan }
    : { decision: "start_work", plan };
}
