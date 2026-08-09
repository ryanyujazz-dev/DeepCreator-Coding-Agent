import assert from "node:assert/strict";
import test from "node:test";
import { Plan } from "../shared/contracts/runtime";
import { resolveEvalPlanInteraction } from "../shared/domain/evalInteractionPolicy";

function plan(revision: number, status: Plan["status"]): Plan {
  return {
    callId: `call_${revision}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    markdown: "# Plan",
    planId: "plan_eval",
    revision,
    runId: "run_eval",
    sessionId: "session_eval",
    status,
    title: "Plan",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

test("automatically approves every proposed evaluation plan by default", () => {
  const resolution = resolveEvalPlanInteraction([plan(1, "proposed")], "run_eval");
  assert.equal(resolution?.decision, "start_work");
  assert.equal(resolution?.plan.revision, 1);
});

test("requests one configured revision and then approves the replacement", () => {
  const first = resolveEvalPlanInteraction([plan(1, "proposed")], "run_eval", "补充恢复策略。");
  const second = resolveEvalPlanInteraction([plan(1, "rejected"), plan(2, "proposed")], "run_eval", "补充恢复策略。");
  assert.deepEqual({ comments: first?.comments, decision: first?.decision }, {
    comments: "补充恢复策略。",
    decision: "continue_planning"
  });
  assert.equal(second?.decision, "start_work");
  assert.equal(second?.plan.revision, 2);
});
