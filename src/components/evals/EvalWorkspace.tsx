import { CSSProperties, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Beaker, MoreHorizontal, PanelRight } from "lucide-react";
import {
  DEFAULT_EVAL_JUDGE,
  DEFAULT_EVAL_JUDGE_MODEL,
  EvalBatchRunRecord,
  EvalCaseSummary,
  EvalRunRecord
} from "../../../shared/contracts/evals";
import { Changes, isRunDone, Plan, PlanDecision, QuestionAnswer } from "../../../shared/contracts/runtime";
import { ModelOption } from "../../../shared/contracts/provider";
import { Composer } from "../Composer";
import { ConnectionPhase, ConnectionStatus } from "../ConnectionStatus";
import { Conversation } from "../Conversation";
import { TaskProgress } from "../TaskProgress";
import { IconButton } from "../../shared-ui/ControlPrimitives";
import { RuntimeConfig, runtimeApi } from "../../runtimeApi";
import { SessionEventStore } from "../../features/runtime/sessionEventStore";
import { browserPlatform } from "../../platform/browser";
import { EvalObserver } from "./EvalObserver";
import { EvalSidebar } from "./EvalSidebar";
import { evalRuntimeApi } from "./evalRuntimeApi";
import "../../styles/features/evals.css";

const DEFAULT_OBSERVER_WIDTH = 440;

function latestRunByCase(runs: EvalRunRecord[]): Map<string, EvalRunRecord> {
  const result = new Map<string, EvalRunRecord>();
  for (const run of runs) if (!result.has(run.caseId)) result.set(run.caseId, run);
  return result;
}

function evalRunActive(run?: EvalRunRecord): boolean {
  return Boolean(run && ["queued", "preparing", "running_agent", "verifying", "judging"].includes(run.stage));
}

export function EvalWorkspace({
  config,
  connection,
  onBack,
  onWidthChange,
  onWidthReset,
  sidebarWidth,
  viewportWidth
}: {
  config: RuntimeConfig;
  connection: ConnectionPhase;
  onBack: () => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  sidebarWidth: number;
  viewportWidth: number;
}) {
  const [sessionStore] = useState(() => new SessionEventStore());
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot);
  const [cases, setCases] = useState<EvalCaseSummary[]>([]);
  const [runs, setRuns] = useState<EvalRunRecord[]>([]);
  const [batches, setBatches] = useState<EvalBatchRunRecord[]>([]);
  const [batchStarting, setBatchStarting] = useState(false);
  const [batchControlBusy, setBatchControlBusy] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedEvalRunId, setSelectedEvalRunId] = useState<string | null>(null);
  const [model, setModel] = useState(config.hasApiKey ? config.defaultModel : "mock-agent");
  const [judge, setJudge] = useState<"heuristic" | "provider">(DEFAULT_EVAL_JUDGE);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_EVAL_JUDGE_MODEL);
  const [error, setError] = useState<string | null>(null);
  const [observerOpen, setObserverOpen] = useState(false);
  const [observerWidth, setObserverWidth] = useState(() => Number(browserPlatform.storage.get("deepcreator.evalObserverWidth")) || DEFAULT_OBSERVER_WIDTH);
  const runByCase = useMemo(() => latestRunByCase(runs), [runs]);
  const selectedCase = cases.find((item) => item.caseId === selectedCaseId) ?? cases[0];
  const selectedHistoryJob = selectedEvalRunId ? runs.find((item) => item.evalRunId === selectedEvalRunId) : undefined;
  const selectedJob = selectedHistoryJob?.caseId === selectedCase?.caseId
    ? selectedHistoryJob
    : selectedCase
      ? runByCase.get(selectedCase.caseId)
      : undefined;
  const selectedJobEvalRunId = selectedJob?.evalRunId;
  const selectedJobSessionId = selectedJob?.sessionId;
  const selectedJobExists = Boolean(selectedJob);
  const selectedJobActive = evalRunActive(selectedJob);
  const currentRun = session?.runs.at(-1);
  const activeRun = [...(session?.runs ?? [])].reverse().find((run) => !isRunDone(run.status));
  const waitingRun = activeRun?.status === "waiting" ? activeRun : undefined;
  const pendingPlan = waitingRun
    ? [...(session?.plans ?? [])].reverse().find((plan) => plan.runId === waitingRun.runId && plan.status === "proposed")
    : undefined;
  const pendingQuestion = waitingRun
    ? [...(session?.questions ?? [])].reverse().find((question) => question.runId === waitingRun.runId && question.status === "pending")
    : undefined;
  const pendingApproval = activeRun?.approvals.find((approval) => approval.state === "pending");
  const evaluationBusy = evalRunActive(selectedJob);
  const agentRunning = Boolean(activeRun && activeRun.status !== "waiting") || Boolean(selectedJob?.stage === "queued" || selectedJob?.stage === "preparing" || selectedJob?.stage === "verifying" || selectedJob?.stage === "judging");
  const activeTask = currentRun?.tasks.find((task) => task.status === "running");
  const workLabel = selectedJob?.stage === "queued"
    ? "等待并发评测空位"
    : selectedJob?.stage === "preparing"
      ? "正在准备隔离测试项目"
      : selectedJob?.stage === "verifying"
        ? "正在验证任务结果"
        : selectedJob?.stage === "judging"
          ? "正在评估过程 Content"
          : activeTask?.label ?? "模型正在处理评测任务";
  const observerMaximum = Math.max(360, Math.min(760, viewportWidth - sidebarWidth - 420));
  const effectiveObserverWidth = Math.min(observerWidth, observerMaximum);
  const pendingConversation = selectedJobActive && selectedJobEvalRunId && (!selectedJobSessionId || session?.sessionId !== selectedJobSessionId)
    ? { key: selectedJobEvalRunId, label: selectedJob?.stage === "queued" ? "正在等待并发评测空位" : "正在准备评测环境", prompt: selectedCase?.userRequest ?? "" }
    : undefined;

  const refreshEvaluationState = useCallback(async () => {
    const [runResponse, batchResponse] = await Promise.all([evalRuntimeApi.listRuns(), evalRuntimeApi.listBatches()]);
    setRuns(runResponse.runs);
    setBatches(batchResponse.batches);
    return runResponse.runs;
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([evalRuntimeApi.listCases(), evalRuntimeApi.listRuns(), evalRuntimeApi.listBatches()])
      .then(([caseResponse, runResponse, batchResponse]) => {
        if (disposed) return;
        setCases(caseResponse.cases);
        setRuns(runResponse.runs);
        setBatches(batchResponse.batches);
        setSelectedCaseId((current) => current ?? caseResponse.cases.find((item) => item.status === "ready")?.caseId ?? caseResponse.cases[0]?.caseId ?? null);
      })
      .catch((nextError) => { if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshEvaluationState().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
    }, runs.some(evalRunActive) || batches.some((batch) => batch.stage === "running") ? 800 : 3_000);
    return () => window.clearInterval(timer);
  }, [batches, refreshEvaluationState, runs]);

  useEffect(() => {
    if (!selectedJobExists) {
      sessionStore.update(null);
      return;
    }
    if (!selectedJobSessionId || !selectedJobEvalRunId) {
      sessionStore.update(null);
      return;
    }
    let disposed = false;
    let closeStream: () => void = () => undefined;
    void evalRuntimeApi.getRunSession(selectedJobEvalRunId).then(({ session: snapshot }) => {
      if (disposed) return;
      sessionStore.replaceSnapshot(snapshot);
      if (!selectedJobActive) return;
      closeStream = runtimeApi.subscribe({
        afterOffset: snapshot.lastOffset,
        onError: (nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)),
        onEvents: (events) => sessionStore.applyEvents(selectedJobSessionId, events),
        onOpen: () => undefined,
        sessionId: selectedJobSessionId
      });
    }).catch((nextError) => { if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { disposed = true; closeStream(); };
  }, [selectedJobActive, selectedJobEvalRunId, selectedJobExists, selectedJobSessionId, sessionStore]);

  useEffect(() => browserPlatform.storage.set("deepcreator.evalObserverWidth", String(Math.round(observerWidth))), [observerWidth]);

  useEffect(() => {
    if (!selectedEvalRunId) {
      setJudge(DEFAULT_EVAL_JUDGE);
      setJudgeModel(DEFAULT_EVAL_JUDGE_MODEL);
      return;
    }
    setJudge(selectedJob?.judge ?? DEFAULT_EVAL_JUDGE);
    setJudgeModel(selectedJob?.judgeModel ?? DEFAULT_EVAL_JUDGE_MODEL);
  }, [selectedEvalRunId, selectedJob?.evalRunId, selectedJob?.judge, selectedJob?.judgeModel]);

  const selectCase = useCallback((caseId: string) => {
    setSelectedCaseId(caseId);
    setSelectedEvalRunId(null);
    setError(null);
  }, []);

  const selectRun = useCallback((evalRunId: string) => {
    const run = runs.find((item) => item.evalRunId === evalRunId);
    if (!run) return;
    setSelectedCaseId(run.caseId);
    setSelectedEvalRunId(run.evalRunId);
    setError(null);
  }, [runs]);

  const startEvaluation = useCallback(async (): Promise<boolean> => {
    if (!selectedCase || selectedCase.status !== "ready") return false;
    setError(null);
    try {
      const response = await evalRuntimeApi.startRun({ caseId: selectedCase.caseId, judge, judgeModel: judge === "provider" ? judgeModel : undefined, model, promptVersion: "current" });
      setRuns((current) => [response.run, ...current.filter((item) => item.evalRunId !== response.run.evalRunId)]);
      setSelectedEvalRunId(response.run.evalRunId);
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    }
  }, [judge, judgeModel, model, selectedCase]);

  const startBatchEvaluation = useCallback(async () => {
    setBatchStarting(true);
    setError(null);
    try {
      const response = await evalRuntimeApi.startBatch({
        judge,
        judgeModel: judge === "provider" ? judgeModel : undefined,
        model,
        promptVersion: "current"
      });
      setBatches((current) => [response.batch, ...current.filter((item) => item.batchId !== response.batch.batchId)]);
      const nextRuns = await refreshEvaluationState();
      const first = response.batch.cases[0];
      const firstRun = first ? nextRuns.find((item) => item.evalRunId === first.evalRunId) : undefined;
      if (firstRun) {
        setSelectedCaseId(firstRun.caseId);
        setSelectedEvalRunId(firstRun.evalRunId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBatchStarting(false);
    }
  }, [judge, judgeModel, model, refreshEvaluationState]);

  const setBatchPaused = useCallback(async (batchId: string, paused: boolean) => {
    setBatchControlBusy(true);
    setError(null);
    try {
      const response = paused
        ? await evalRuntimeApi.pauseBatch(batchId)
        : await evalRuntimeApi.resumeBatch(batchId);
      setBatches((current) => current.map((item) => item.batchId === response.batch.batchId ? response.batch : item));
      await refreshEvaluationState();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBatchControlBusy(false);
    }
  }, [refreshEvaluationState]);

  const cancel = useCallback(async () => {
    if (!selectedJob?.runId) return;
    try {
      await runtimeApi.cancelRun(selectedJob.runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [selectedJob?.runId]);

  const resolvePlan = useCallback(async (plan: Plan, decision: PlanDecision, comments?: string, nextAccessMode?: "request_approval" | "smart_approval" | "full_access") => {
    if (!session) return;
    try {
      const response = await runtimeApi.resolvePlan(session.sessionId, plan, { accessMode: nextAccessMode, comments, decision });
      sessionStore.replaceSnapshot(response.session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session, sessionStore]);

  const answerQuestion = useCallback(async (interactionId: string, answers: Record<string, QuestionAnswer>) => {
    if (!session) return;
    const response = await runtimeApi.answerQuestion(session.sessionId, interactionId, answers);
    sessionStore.replaceSnapshot(response.session);
  }, [session, sessionStore]);

  const revealObserver = useCallback((_value?: string | Changes) => setObserverOpen(true), []);

  if (!selectedCase) {
    return <main className="workspace"><div className="surface-state">正在载入评测数据集...</div></main>;
  }

  return (
    <>
      <EvalSidebar batches={batches} batchControlBusy={batchControlBusy} batchStarting={batchStarting} cases={cases} onBack={onBack} onPauseBatch={(batchId) => void setBatchPaused(batchId, true)} onResumeBatch={(batchId) => void setBatchPaused(batchId, false)} onSelectCase={selectCase} onSelectRun={selectRun} onStartBatch={() => void startBatchEvaluation()} onWidthChange={onWidthChange} onWidthReset={onWidthReset} runs={runs} selectedCaseId={selectedCase.caseId} selectedEvalRunId={selectedEvalRunId} sidebarWidth={sidebarWidth} />
      <main className={`workspace conversation-workspace eval-workspace ${observerOpen ? "has-surface" : ""}`} style={{ "--surface-width": `${effectiveObserverWidth}px` } as CSSProperties}>
        <div className="conversation-main inspector-layout-none">
          <header className="thread-header">
            <div className="thread-title"><Beaker size={16} /><span>{selectedCase.caseId} · {selectedCase.title}{selectedEvalRunId && selectedJob ? ` · 第 ${selectedJob.attempt} 次` : ""}</span><MoreHorizontal size={14} /></div>
            <ConnectionStatus phase={connection} />
          </header>
          <div className="window-actions"><IconButton className={observerOpen ? "icon-button is-active" : "icon-button"} label="评测观察器" onClick={() => setObserverOpen((open) => !open)}><PanelRight size={14} /></IconButton></div>
          <Conversation notices={[]} onOpenAgent={() => setObserverOpen(true)} onOpenFile={revealObserver} onOpenPlan={() => setObserverOpen(true)} onOpenReview={revealObserver} onStopCommand={(commandId) => void runtimeApi.stopCommand(commandId)} pendingRun={pendingConversation} session={session} />
          {error && <div className="conversation-error-overlay"><div className="conversation-error-toast" role="alert">{error}</div></div>}
          <div className="composer-stack eval-composer-stack">
            <div className="eval-prompt-label"><span>评测数据集 · {selectedCase.caseId}</span><strong>任务内容只读</strong></div>
            {currentRun && <div aria-hidden={!evaluationBusy || Boolean(pendingPlan || pendingQuestion)} className={`composer-hud is-${currentRun.status} ${evaluationBusy && !pendingPlan && !pendingQuestion ? "is-visible" : "is-collapsed"}`}><TaskProgress active={agentRunning} label={workLabel} tasks={currentRun.tasks} /></div>}
            <Composer
              balance={null}
              contextConfig={config}
              contextObserver={null}
              disabledReason={selectedCase.status === "planned" ? "该 Case 尚未配置可运行 Fixture" : undefined}
              followUps={[]}
              isRunning={agentRunning}
              isWaiting={Boolean(waitingRun)}
              model={model}
              models={config.models as ModelOption[]}
              onAccessModeChange={() => undefined}
              onAnswerQuestion={answerQuestion}
              onInterruptQuestion={async (interactionId, prompt) => {
                if (!session) return false;
                const response = await runtimeApi.interruptQuestion(session.sessionId, interactionId, {
                  accessMode: session.accessMode,
                  mode: session.mode,
                  model: session.model,
                  planEntry: session.planEntry,
                  prompt,
                  requestId: browserPlatform.createId("question_interrupt")
                });
                sessionStore.replaceSnapshot(response.session);
                return true;
              }}
              onCancel={() => void cancel()}
              onModeChange={() => undefined}
              onModelChange={setModel}
              onRefreshBalance={() => undefined}
              onRemoveFollowUp={() => undefined}
              onResolveApproval={(decision) => pendingApproval ? runtimeApi.resolveApproval(pendingApproval.approvalId, decision).then(() => undefined) : undefined}
              onResolvePlan={resolvePlan}
              onSteerFollowUp={() => undefined}
              onSubmit={startEvaluation}
              pendingApproval={pendingApproval}
              pendingPlan={pendingPlan}
              pendingQuestion={pendingQuestion}
              presetPrompt={selectedCase.userRequest}
              promptReadOnly
              resetKey={`${selectedCase.caseId}:${selectedJob?.evalRunId ?? "new"}`}
              accessMode="full_access"
              mode={selectedCase.initialMode}
            />
          </div>
        </div>
        {observerOpen && <EvalObserver evalCase={selectedCase} job={selectedJob} judge={judge} judgeModel={judgeModel} models={config.models} onClose={() => setObserverOpen(false)} onJudgeChange={setJudge} onJudgeModelChange={setJudgeModel} onWidthChange={setObserverWidth} onWidthReset={() => setObserverWidth(DEFAULT_OBSERVER_WIDTH)} panelMaxWidth={() => observerMaximum} panelWidth={effectiveObserverWidth} run={currentRun} />}
      </main>
    </>
  );
}
