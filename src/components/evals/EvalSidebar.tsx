import { ArrowLeft, Beaker, CheckCircle2, ChevronRight, CircleDashed, History, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { EvalCaseSummary, EvalRunRecord } from "../../../shared/contracts/evals";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { OverflowFadeText } from "../OverflowFadeText";
import { RowAction } from "../../shared-ui/ControlPrimitives";
import { completedEvalRunsByCase, isEvalRunActive, latestEvalRunsByCase } from "./evalSidebarProjection";

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
  cases,
  onBack,
  onSelectCase,
  onSelectRun,
  onWidthChange,
  onWidthReset,
  runs,
  selectedCaseId,
  selectedEvalRunId,
  sidebarWidth
}: {
  cases: EvalCaseSummary[];
  onBack: () => void;
  onSelectCase: (caseId: string) => void;
  onSelectRun: (evalRunId: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  runs: EvalRunRecord[];
  selectedCaseId: string | null;
  selectedEvalRunId: string | null;
  sidebarWidth: number;
}) {
  const [query, setQuery] = useState("");
  const [expandedCases, setExpandedCases] = useState<Set<string>>(() => new Set());
  const runByCase = useMemo(() => latestEvalRunsByCase(runs), [runs]);
  const historyByCase = useMemo(() => completedEvalRunsByCase(runs), [runs]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? cases.filter((item) => `${item.caseId} ${item.title} ${item.scenario}`.toLocaleLowerCase().includes(normalized))
      : cases;
  }, [cases, query]);
  const selectedRun = selectedEvalRunId ? runs.find((run) => run.evalRunId === selectedEvalRunId) : undefined;
  const resultCases = filtered.filter((item) => (historyByCase.get(item.caseId)?.length ?? 0) > 0);

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
          <h2>评测集</h2>
          {filtered.map((item) => {
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
        </section>
        <section className="sidebar-section eval-results-section">
          <h2>评测结果</h2>
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
          {resultCases.length === 0 && <div className="sidebar-empty eval-results-empty">暂无评测结果</div>}
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
