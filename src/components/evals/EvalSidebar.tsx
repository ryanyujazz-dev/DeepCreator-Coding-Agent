import { ArrowLeft, Beaker, CheckCircle2, ChevronRight, CircleDashed, History, LoaderCircle, Pause, Play, Search, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EvalBatchRunRecord, EvalCaseSummary, EvalRunRecord, EvalScenario } from "../../../shared/contracts/evals";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { OverflowFadeText } from "../OverflowFadeText";
import { PillButton, RowAction } from "../../shared-ui/ControlPrimitives";
import {
  completedSingleEvalRunsByCase,
  evalScenarioLabel,
  groupEvalCasesByScenario,
  isEvalRunActive,
  latestEvalRunsByCase
} from "./evalSidebarProjection";

function formatRunTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

export function EvalSidebar({
  batches,
  batchControlBusy,
  batchStarting,
  cases,
  onBack,
  onPauseBatch,
  onResumeBatch,
  onStartBatch,
  onSelectCase,
  onSelectRun,
  onWidthChange,
  onWidthReset,
  runs,
  selectedCaseId,
  selectedEvalRunId,
  sidebarWidth
}: {
  batches: EvalBatchRunRecord[];
  batchControlBusy: boolean;
  batchStarting: boolean;
  cases: EvalCaseSummary[];
  onBack: () => void;
  onPauseBatch: (batchId: string) => void;
  onResumeBatch: (batchId: string) => void;
  onSelectCase: (caseId: string) => void;
  onSelectRun: (evalRunId: string) => void;
  onStartBatch: () => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  runs: EvalRunRecord[];
  selectedCaseId: string | null;
  selectedEvalRunId: string | null;
  sidebarWidth: number;
}) {
  const [query, setQuery] = useState("");
  const [expandedCases, setExpandedCases] = useState<Set<string>>(() => new Set());
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(() => new Set());
  const [collapsedScenarios, setCollapsedScenarios] = useState<Set<EvalScenario>>(() => new Set());
  const runByCase = useMemo(() => latestEvalRunsByCase(runs), [runs]);
  const historyByCase = useMemo(() => completedSingleEvalRunsByCase(runs), [runs]);
  const runsById = useMemo(() => new Map(runs.map((run) => [run.evalRunId, run])), [runs]);
  const casesById = useMemo(() => new Map(cases.map((item) => [item.caseId, item])), [cases]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? cases.filter((item) => `${item.caseId} ${item.title} ${item.scenario} ${evalScenarioLabel(item.scenario)}`.toLocaleLowerCase().includes(normalized))
      : cases;
  }, [cases, query]);
  const groupedCases = useMemo(() => groupEvalCasesByScenario(filtered), [filtered]);
  const isFiltering = query.trim().length > 0;
  const selectedRun = selectedEvalRunId ? runs.find((run) => run.evalRunId === selectedEvalRunId) : undefined;
  const resultCases = filtered.filter((item) => (historyByCase.get(item.caseId)?.length ?? 0) > 0);
  const controllableBatch = batches.find((batch) => batch.stage === "running" || batch.stage === "paused");
  const batchActive = controllableBatch?.stage === "running";
  const batchPaused = controllableBatch?.stage === "paused";
  const runAllDisabled = batchStarting || Boolean(controllableBatch) || runs.some(isEvalRunActive) || cases.some((item) => item.status !== "ready");

  useEffect(() => {
    const activeIds = batches.filter((batch) => batch.stage === "running" || batch.stage === "paused").map((batch) => batch.batchId);
    if (activeIds.length === 0) return;
    setExpandedBatches((current) => new Set([...current, ...activeIds]));
  }, [batches]);

  return (
    <aside className="sidebar eval-sidebar">
      <div className="sidebar-brand-row">
        <div className="sidebar-brand-lockup"><strong className="sidebar-brand">评测中心</strong></div>
        <Beaker size={16} />
      </div>
      <nav className="primary-nav">
        <RowAction className="nav-row" onClick={onBack}><ArrowLeft size={17} /><span>返回设置</span></RowAction>
      </nav>
      <label className="session-search eval-case-search">
        <Search size={13} />
        <input aria-label="搜索评测 Case" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Case" value={query} />
      </label>
      <div className="sidebar-content">
        <section className="sidebar-section eval-dataset-section">
          <header className="eval-section-heading">
            <h2>评测集</h2>
            <div className="eval-section-actions">
              <PillButton
                aria-label="运行全量评测"
                className="eval-run-all-button"
                disabled={runAllDisabled}
                onClick={onStartBatch}
                title={cases.some((item) => item.status !== "ready") ? "全部 Case 配置完成后可运行" : "并行运行全部 Case"}
              >
                {batchStarting || batchActive ? <LoaderCircle className="eval-spin" size={12} /> : batchPaused ? <Pause size={11} /> : <Play size={11} />}
                <span>{batchStarting || batchActive ? "运行中" : batchPaused ? "已暂停" : "运行全部"}</span>
              </PillButton>
              {controllableBatch && (
                <PillButton
                  aria-label={batchPaused ? "继续全量评测" : "暂停全量评测"}
                  className="eval-batch-control-button"
                  disabled={batchControlBusy}
                  onClick={() => batchPaused ? onResumeBatch(controllableBatch.batchId) : onPauseBatch(controllableBatch.batchId)}
                  title={batchPaused ? "继续派发剩余 Case" : "暂停派发新的 Case；正在执行的 Case 会继续完成"}
                >
                  {batchControlBusy ? <LoaderCircle className="eval-spin" size={12} /> : batchPaused ? <Play size={11} /> : <Pause size={11} />}
                  <span>{batchPaused ? "继续" : "暂停"}</span>
                </PillButton>
              )}
            </div>
          </header>
          <div className="eval-scenario-groups">
            {groupedCases.map((group) => {
              const collapsed = !isFiltering && collapsedScenarios.has(group.scenario);
              const casesId = `eval-scenario-cases-${group.scenario}`;
              const headingId = `eval-scenario-${group.scenario}`;
              const toggleScenario = () => {
                setCollapsedScenarios((current) => {
                  const next = new Set(current);
                  if (next.has(group.scenario)) next.delete(group.scenario);
                  else next.add(group.scenario);
                  return next;
                });
              };
              return (
                <section aria-labelledby={headingId} className="eval-scenario-group" key={group.scenario}>
                  <h3 className="eval-scenario-title">
                    <RowAction
                      aria-controls={casesId}
                      aria-expanded={!collapsed}
                      className="eval-scenario-heading"
                      id={headingId}
                      onClick={toggleScenario}
                    >
                      <ChevronRight className="eval-scenario-chevron" size={12} />
                      <span>{group.label}</span>
                      <small>{group.cases.length}</small>
                    </RowAction>
                  </h3>
                  {!collapsed && (
                    <div className="eval-scenario-cases" id={casesId}>
                      {group.cases.map((item) => {
                        const run = runByCase.get(item.caseId);
                        const active = isEvalRunActive(run);
                        const selectedInDataset = selectedCaseId === item.caseId && (!selectedEvalRunId || isEvalRunActive(selectedRun));
                        return (
                          <div className="eval-case-group" key={item.caseId}>
                            <div className={`thread-row-shell is-top-level ${selectedInDataset ? "active-thread" : ""}`}>
                              {active && <span className="session-running" />}
                              <RowAction className="thread-row eval-case-row eval-dataset-row" onClick={() => onSelectCase(item.caseId)}>
                                <span className={`eval-case-status is-${item.status} is-${run?.stage ?? "idle"}`}><CircleDashed size={13} /></span>
                                <span className="eval-case-copy"><small>{item.caseId}</small><OverflowFadeText>{item.title}</OverflowFadeText></span>
                                {item.status === "planned" && <small className="eval-case-availability">未配置</small>}
                              </RowAction>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </section>
        <section className="sidebar-section eval-results-section eval-batch-results-section">
          <h2>全量评测结果</h2>
          {batches.map((batch) => {
            const expanded = expandedBatches.has(batch.batchId);
            const selectedInBatch = batch.cases.some((item) => item.evalRunId === selectedEvalRunId);
            const toggleBatch = () => {
              setExpandedBatches((current) => {
                const next = new Set(current);
                if (next.has(batch.batchId)) next.delete(batch.batchId);
                else next.add(batch.batchId);
                return next;
              });
            };
            return (
              <div className="eval-case-group" key={batch.batchId}>
                <div className={`thread-row-shell is-top-level ${selectedInBatch ? "active-thread" : ""}`}>
                  {batch.stage === "running" && <span className="session-running" />}
                  <RowAction aria-expanded={expanded} className="thread-row eval-case-row eval-case-parent-row eval-batch-row" onClick={toggleBatch}>
                    <span className={`eval-case-status is-${batch.stage}`}>
                      {batch.stage === "running"
                        ? <LoaderCircle className="eval-spin" size={13} />
                        : batch.stage === "paused"
                          ? <Pause size={13} />
                        : batch.stage === "failed"
                          ? <XCircle size={13} />
                          : <CheckCircle2 size={13} />}
                    </span>
                    <span className="eval-case-copy">
                      <small>{formatRunTime(batch.createdAt)} · {batch.model}</small>
                      <OverflowFadeText>{batch.stage === "running"
                        ? `${batch.completedCases}/${batch.cases.length} 已完成`
                        : batch.stage === "paused"
                          ? `已暂停 · ${batch.completedCases}/${batch.cases.length} 已完成`
                        : batch.stage === "failed"
                          ? "批次数据异常"
                          : `${batch.passedCases}/${batch.cases.length} 通过`}</OverflowFadeText>
                    </span>
                    <span className="eval-batch-trailing">
                      {batch.weightedAverage !== undefined && <strong title="按难度加权：简单 1、中等 1.5、困难 2；失败或取消按 0 分计入">{batch.weightedAverage}</strong>}
                      <ChevronRight className="eval-case-chevron" size={14} />
                    </span>
                  </RowAction>
                </div>
                {expanded && (
                  <div className="eval-run-history eval-batch-run-list">
                    {batch.cases.map((batchCase) => {
                      const run = runsById.get(batchCase.evalRunId);
                      const evalCase = casesById.get(batchCase.caseId);
                      const score = run?.result?.scores.total;
                      return (
                        <div className={`thread-row-shell eval-history-shell ${selectedEvalRunId === batchCase.evalRunId ? "active-thread" : ""}`} key={batchCase.evalRunId}>
                          <RowAction className="thread-row eval-case-row eval-history-row" disabled={!run} onClick={() => onSelectRun(batchCase.evalRunId)}>
                            <span className={`eval-case-status is-${run?.stage ?? "queued"}`}>
                              {isEvalRunActive(run) ? <LoaderCircle className="eval-spin" size={12} /> : <History size={12} />}
                            </span>
                            <span className="eval-case-copy">
                              <small>{batchCase.caseId} · 权重 {batchCase.weight}</small>
                              <OverflowFadeText>{evalCase?.title ?? batchCase.caseId}</OverflowFadeText>
                            </span>
                            {score !== undefined
                              ? <strong className={run?.result?.passed ? "is-pass" : "is-fail"}>{score}</strong>
                              : <small className="eval-history-stage">{run?.stage === "queued" ? "排队中" : run?.stage === "failed" ? "失败" : run?.stage === "cancelled" ? "已取消" : "执行中"}</small>}
                          </RowAction>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {batches.length === 0 && <div className="sidebar-empty eval-results-empty">暂无全量评测结果</div>}
        </section>
        <section className="sidebar-section eval-results-section">
          <h2>单次评测结果</h2>
          {resultCases.map((item) => {
            const historyRuns = historyByCase.get(item.caseId) ?? [];
            const latestResultRun = historyRuns[0];
            const expanded = expandedCases.has(item.caseId);
            const selectedInResults = selectedCaseId === item.caseId && Boolean(selectedEvalRunId) && !isEvalRunActive(selectedRun);
            const toggleHistory = () => {
              setExpandedCases((current) => {
                const next = new Set(current);
                if (next.has(item.caseId)) next.delete(item.caseId);
                else next.add(item.caseId);
                return next;
              });
            };
            return (
              <div className="eval-case-group" key={item.caseId}>
                <div className={`thread-row-shell is-top-level ${selectedInResults ? "active-thread" : ""}`}>
                  <RowAction aria-expanded={expanded} className="thread-row eval-case-row eval-case-parent-row eval-result-row" onClick={toggleHistory}>
                    <span className={`eval-case-status is-${latestResultRun.stage}`}>
                      {latestResultRun.stage === "completed" ? <CheckCircle2 size={13} /> : <History size={12} />}
                    </span>
                    <span className="eval-case-copy"><small>{item.caseId}</small><OverflowFadeText>{item.title}</OverflowFadeText></span>
                    <span className="eval-result-trailing">
                      <ChevronRight className="eval-case-chevron" size={14} />
                    </span>
                  </RowAction>
                </div>
                {expanded && (
                  <div className="eval-run-history">
                    {historyRuns.map((historyRun) => {
                      const historyScore = historyRun.result?.scores.total;
                      return (
                        <div className={`thread-row-shell eval-history-shell ${selectedEvalRunId === historyRun.evalRunId ? "active-thread" : ""}`} key={historyRun.evalRunId}>
                          <RowAction className="thread-row eval-case-row eval-history-row" onClick={() => onSelectRun(historyRun.evalRunId)}>
                            <span className={`eval-case-status is-${historyRun.stage}`}><History size={12} /></span>
                            <span className="eval-case-copy">
                              <small>第 {historyRun.attempt} 次 · {formatRunTime(historyRun.createdAt)}</small>
                              <OverflowFadeText>{historyRun.model}</OverflowFadeText>
                            </span>
                            {historyScore !== undefined
                              ? <strong className={historyRun.result?.passed ? "is-pass" : "is-fail"}>{historyScore}</strong>
                              : <small className="eval-history-stage">{historyRun.stage === "failed" ? "失败" : "已取消"}</small>}
                          </RowAction>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {resultCases.length === 0 && <div className="sidebar-empty eval-results-empty">暂无单次评测结果</div>}
        </section>
        {filtered.length === 0 && <div className="sidebar-empty">没有匹配的 Case</div>}
      </div>
      <div className="account-strip eval-sidebar-summary">
        <div className="avatar">EV</div>
        <div><strong>{cases.filter((item) => item.status === "ready").length} Ready</strong><span>{cases.length} Cases</span></div>
      </div>
      <PanelResizeHandle ariaLabel="调整评测侧栏宽度" edge="right" max={360} min={220} onChange={onWidthChange} onReset={onWidthReset} value={sidebarWidth} />
    </aside>
  );
}
