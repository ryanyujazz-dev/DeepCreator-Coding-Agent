import { Session } from "../../shared/contracts/runtime";
import { missingToolResults } from "../../shared/domain/toolProtocol";
import { ContextPort, EventPort, SessionPort } from "./runtimeRepo";
import { appendInterruptedToolResults, finishRun } from "./runLifecycle";
import { SystemPort } from "./systemPort";

type RecoveryPorts = ContextPort & EventPort & SessionPort;

export type RuntimeRecoveryReport = {
  interruptedRuns: number;
  repairedToolResults: number;
};

/** Converges persisted Runtime state after a process restart. */
export function recoverRuntimeState(store: RecoveryPorts, snapshots: Session[], system: SystemPort): RuntimeRecoveryReport {
  let interruptedRuns = 0;
  for (const snapshot of snapshots) {
    for (const run of snapshot.runs) {
      if (run.status !== "running" && run.status !== "waiting" && run.status !== "queued") continue;
      const hasDurablePlanWait = run.status === "waiting"
        && snapshot.plans.some((plan) => plan.runId === run.runId && plan.status === "proposed");
      const hasDurableQuestionWait = run.status === "waiting"
        && snapshot.questions.some((question) => question.runId === run.runId && question.status === "pending");
      if (hasDurablePlanWait || hasDurableQuestionWait) continue;
      finishRun({
        answer: "上一次运行因 Runtime 重启而中断。",
        error: "Runtime restarted before this Run reached a terminal state.",
        failureType: "interrupted",
        projectRoot: snapshot.projectRoot,
        runId: run.runId,
        sessionId: snapshot.sessionId,
        status: "failed",
        store,
        system
      });
      interruptedRuns += 1;
    }
  }

  let repairedToolResults = 0;
  for (const { sessionId } of snapshots) {
    const session = store.getSession(sessionId);
    if (!session) continue;
    const records = store.readContextEntries(sessionId);
    for (const run of session.runs.filter((item) => ["completed", "failed", "cancelled"].includes(item.status))) {
      const missingResults = missingToolResults(records.filter((record) => record.runId === run.runId));
      if (missingResults.length === 0) continue;
      repairedToolResults += appendInterruptedToolResults({
        interruptionReason: `历史运行已处于 ${run.status} 状态，但没有留下完整工具结果`,
        missingResults,
        runId: run.runId,
        sessionId,
        store,
        system,
        terminalPhase: run.status as "completed" | "failed" | "cancelled"
      });
    }
  }
  return { interruptedRuns, repairedToolResults };
}
