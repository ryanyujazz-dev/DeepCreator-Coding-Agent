import { CSSProperties, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Beaker, MoreHorizontal, PanelRight } from "lucide-react";
import { EvalCaseSummary, EvalRunRecord } from "../../../shared/contracts/evals";
import { Changes, isRunDone, Plan, PlanDecision } from "../../../shared/contracts/runtime";
import { ModelOption } from "../../../shared/contracts/provider";
import { ApprovalDialog } from "../ApprovalDialog";
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
  return Boolean(run && ["preparing", "running_agent", "verifying", "judging"].includes(run.stage));
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
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedEvalRunId, setSelectedEvalRunId] = useState<string | null>(null);
  const [model, setModel] = useState(config.hasApiKey ? config.defaultModel : "mock-agent");
  const [judge, setJudge] = useState<"heuristic" | "provider">("heuristic");
  const [judgeModel, setJudgeModel] = useState(config.defaultModel);
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
  const agentRunning = Boolean(activeRun && activeRun.status !== "waiting") || Boolean(selectedJob?.stage === "preparing" || selectedJob?.stage === "verifying" || selectedJob?.stage === "judging");
  const activeTask = currentRun?.tasks.find((task) => task.status === "running");
  const workLabel = selectedJob?.stage === "preparing"
    ? "正在准备隔离测试项目"
    : selectedJob?.stage === "verifying"
      ? "正在验证任务结果"
      : selectedJob?.stage === "judging"
        ? "正在评估过程 Content"
        : activeTask?.label ?? "模型正在处理评测任务";
  const observerMaximum = Math.max(360, Math.min(760, viewportWidth - sidebarWidth - 420));
  const effectiveObserverWidth = Math.min(observerWidth, observerMaximum);
  const pendingConversation = selectedJobActive && selectedJobEvalRunId && (!selectedJobSessionId || session?.sessionId !== selectedJobSessionId)
    ? { key: selectedJobEvalRunId, label: "正在准备评测环境", prompt: selectedCase?.userRequest ?? "" }
    : undefined;

  const refreshRuns = useCallback(async () => {
    const response = await evalRuntimeApi.listRuns();
    setRuns(response.runs);
    return response.runs;
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([evalRuntimeApi.listCases(), evalRuntimeApi.listRuns()])
      .then(([caseResponse, runResponse]) => {
        if (disposed) return;
        setCases(caseResponse.cases);
        setRuns(runResponse.runs);
        setSelectedCaseId((current) => current ?? caseResponse.cases.find((item) => item.status === "ready")?.caseId ?? caseResponse.cases[0]?.caseId ?? null);
      })
      .catch((nextError) => { if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRuns().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
    }, runs.some(evalRunActive) ? 800 : 3_000);
    return () => window.clearInterval(timer);
  }, [refreshRuns, runs]);

  useEffect(() => {
    if (!selectedJobExists) {
      sessionStore.update(null);
      return;
    }
    if (!selectedJobSessionId || !selectedJobEvalRunId) return;
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
    setJudge(selectedJob?.judge ?? "heuristic");
    setJudgeModel(selectedJob?.judgeModel ?? config.defaultModel);
  }, [config.defaultModel, selectedJob?.evalRunId, selectedJob?.judge, selectedJob?.judgeModel]);

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

  const answerQuestion = useCallback(async (interactionId: string, answers: Record<string, string>) => {
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
      <EvalSidebar cases={cases} onBack={onBack} onSelectCase={selectCase} onSelectRun={selectRun} onWidthChange={onWidthChange} onWidthReset={onWidthReset} runs={runs} selectedCaseId={selectedCase.caseId} selectedEvalRunId={selectedEvalRunId} sidebarWidth={sidebarWidth} />
      <main className={`workspace conversation-workspace eval-workspace ${observerOpen ? "has-surface" : ""}`} style={{ "--surface-width": `${effectiveObserverWidth}px` } as CSSProperties}>
        <div className="conversation-main inspector-layout-none">
          <header className="thread-header">
            <div className="thread-title"><Beaker size={16} /><span>{selectedCase.caseId} · {selectedCase.title}{selectedEvalRunId && selectedJob ? ` · 第 ${selectedJob.attempt} 次` : ""}</span><MoreHorizontal size={14} /></div>
            <ConnectionStatus phase={connection} />
          </header>
          <div className="window-actions"><IconButton className={observerOpen ? "icon-button is-active" : "icon-button"} label="评测观察器" onClick={() => setObserverOpen((open) => !open)}><PanelRight size={14} /></IconButton></div>
          <Conversation notices={[]} onOpenAgent={() => setObserverOpen(true)} onOpenFile={revealObserver} onOpenPlan={() => setObserverOpen(true)} onOpenReview={revealObserver} onStopCommand={(commandId) => void runtimeApi.stopCommand(commandId)} pendingRun={pendingConversation} session={session} />
          {error && <div className="conversation-error-overlay"><div className="conversation-error-toast" role="alert">{error}</div></div>}
          <ApprovalDialog approval={pendingApproval} onResolve={(decision) => void runtimeApi.resolveApproval(pendingApproval!.approvalId, decision)} />
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
              onCancel={() => void cancel()}
              onModeChange={() => undefined}
              onModelChange={setModel}
              onRefreshBalance={() => undefined}
              onRemoveFollowUp={() => undefined}
              onResolvePlan={resolvePlan}
              onSteerFollowUp={() => undefined}
              onSubmit={startEvaluation}
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
