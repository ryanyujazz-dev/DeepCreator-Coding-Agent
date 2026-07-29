import { BarChart3, CheckCircle2, FileDiff, ListChecks, X, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { EvalCaseSummary, EvalRunRecord } from "../../../shared/contracts/evals";
import { ModelOption } from "../../../shared/contracts/provider";
import { Run } from "../../../shared/contracts/runtime";
import { CodeDiffViewer } from "../CodeEditorSurface";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { IconButton } from "../../shared-ui/ControlPrimitives";

type ObserverTab = "score" | "content" | "verification" | "diff";

const stageLabels: Record<EvalRunRecord["stage"], string> = {
  cancelled: "已取消",
  completed: "评测完成",
  failed: "评测失败",
  judging: "正在评分",
  preparing: "准备测试项目",
  running_agent: "模型正在执行",
  verifying: "验证任务结果"
};

const layerLabels: Record<string, string> = {
  context: "上下文管理",
  feedback: "数据反馈",
  interaction: "产品交互",
  model: "模型能力",
  none: "暂无失败归因",
  tool: "工具设计"
};

function ScoreRow({ label, maximum, value }: { label: string; maximum: number; value: number }) {
  return (
    <div className="eval-score-row">
      <div><span>{label}</span><strong>{value} / {maximum}</strong></div>
      <div className="eval-score-track"><span style={{ width: `${Math.max(0, Math.min(100, value / maximum * 100))}%` }} /></div>
    </div>
  );
}

export function EvalObserver({
  evalCase,
  job,
  onClose,
  onJudgeChange,
  onJudgeModelChange,
  onWidthChange,
  onWidthReset,
  panelMaxWidth,
  panelWidth,
  run,
  judge,
  judgeModel,
  models
}: {
  evalCase: EvalCaseSummary;
  job?: EvalRunRecord;
  onClose: () => void;
  onJudgeChange: (judge: "heuristic" | "provider") => void;
  onJudgeModelChange: (model: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  panelMaxWidth: () => number;
  panelWidth: number;
  run?: Run;
  judge: "heuristic" | "provider";
  judgeModel: string;
  models: ModelOption[];
}) {
  const [tab, setTab] = useState<ObserverTab>("score");
  const result = job?.result;
  const changedFiles = useMemo(() => run?.changes.files ?? [], [run?.changes.files]);
  const [activePath, setActivePath] = useState("");
  const activeFile = useMemo(() => changedFiles.find((file) => file.path === activePath) ?? changedFiles[0], [activePath, changedFiles]);
  const running = Boolean(job && ["preparing", "running_agent", "verifying", "judging"].includes(job.stage));

  return (
    <aside className="workspace-surface-panel eval-observer is-open" style={{ width: panelWidth }}>
      <header>
        <div><BarChart3 size={15} /><strong>评测观察器</strong></div>
        <IconButton label="关闭评测观察器" onClick={onClose}><X size={15} /></IconButton>
      </header>
      <div className="eval-observer-summary">
        <div>
          <span>{evalCase.caseId}</span>
          <strong>{result ? `${result.scores.total} / 100` : job ? stageLabels[job.stage] : "等待开始"}</strong>
        </div>
        {result && <span className={result.passed ? "eval-result-badge is-pass" : "eval-result-badge is-fail"}>{result.passed ? "PASS" : "FAIL"}</span>}
      </div>
      <div className="eval-observer-config">
        <label><span>评分模式</span><select disabled={running} onChange={(event) => onJudgeChange(event.target.value as "heuristic" | "provider")} value={judge}><option value="heuristic">本地规则</option><option value="provider">LLM Judge</option></select></label>
        {judge === "provider" && <label><span>Judge 模型</span><select disabled={running} onChange={(event) => onJudgeModelChange(event.target.value)} value={judgeModel}>{models.filter((item) => item.id !== "mock-agent").map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        <div><span>任务模式</span><strong>{evalCase.initialMode === "plan" ? "计划" : "工作"}</strong></div>
      </div>
      <nav className="eval-observer-tabs" aria-label="评测详情">
        <button className={tab === "score" ? "is-active" : ""} onClick={() => setTab("score")} type="button"><BarChart3 size={13} />总览</button>
        <button className={tab === "content" ? "is-active" : ""} onClick={() => setTab("content")} type="button">Content</button>
        <button className={tab === "verification" ? "is-active" : ""} onClick={() => setTab("verification")} type="button"><ListChecks size={13} />验证</button>
        <button className={tab === "diff" ? "is-active" : ""} onClick={() => setTab("diff")} type="button"><FileDiff size={13} />Diff</button>
      </nav>
      <div className="eval-observer-body">
        {!job && <div className="surface-state">选择模型并发送只读任务后，这里会显示实时阶段和评分结果。</div>}
        {job?.error && <div className="surface-state is-error">{job.error}</div>}
        {job && !result && !job.error && <div className="eval-stage-state"><span className="session-running" /><strong>{stageLabels[job.stage]}</strong><p>中间画布展示真实对话与工具调用；评分将在任务结束后生成。</p></div>}
        {result && tab === "score" && <div className="eval-score-list">
          <ScoreRow label="任务结果" maximum={30} value={result.scores.taskOutcome} />
          <ScoreRow label="过程 Content" maximum={25} value={result.scores.processContent.total} />
          <ScoreRow label="工具轨迹" maximum={15} value={result.scores.toolTrajectory} />
          <ScoreRow label="结果验证" maximum={15} value={result.scores.verification} />
          <ScoreRow label="安全性" maximum={10} value={result.scores.safety} />
          <ScoreRow label="执行效率" maximum={5} value={result.scores.efficiency} />
          <div className="eval-attribution-card"><span>主要归因</span><strong>{layerLabels[result.attribution.primaryLayer] ?? result.attribution.primaryLayer}</strong><p>{result.attribution.summary}</p></div>
        </div>}
        {result && tab === "content" && <div className="eval-score-list">
          <ScoreRow label="事实依据" maximum={7} value={result.scores.processContent.evidenceGrounding} />
          <ScoreRow label="分析与判断" maximum={7} value={result.scores.processContent.analysisAndJudgment} />
          <ScoreRow label="逻辑推进" maximum={6} value={result.scores.processContent.logicalProgression} />
          <ScoreRow label="用户价值" maximum={5} value={result.scores.processContent.userValue} />
          <div className="eval-metric-grid"><div><span>有依据声明</span><strong>{Math.round(result.metrics.groundedClaimRate * 100)}%</strong></div><div><span>空洞表达</span><strong>{result.metrics.genericPlaceholderCount}</strong></div><div><span>重复进度</span><strong>{result.metrics.redundantProgressCount}</strong></div><div><span>有效内容</span><strong>{Math.round(result.metrics.substantiveContentRate * 100)}%</strong></div></div>
          {result.judgeFindings.map((finding, index) => <div className="eval-finding" key={`${finding.dimension}-${index}`}><strong>{finding.dimension}</strong><p>{finding.reason}</p><span>置信度 {Math.round(finding.confidence * 100)}%</span></div>)}
        </div>}
        {result && tab === "verification" && <div className="eval-verification-list">
          {result.assertionResults.map((assertion) => <div key={assertion.assertionId}>{assertion.passed ? <CheckCircle2 className="is-pass" size={15} /> : <XCircle className="is-fail" size={15} />}<span><strong>{assertion.assertionId}</strong><small>{assertion.detail}</small></span><b>{assertion.pointsAwarded}/{assertion.pointsAvailable}</b></div>)}
        </div>}
        {tab === "diff" && <div className="eval-diff-view">
          {changedFiles.length > 1 && <select aria-label="选择变更文件" onChange={(event) => setActivePath(event.target.value)} value={activeFile?.path ?? ""}>{changedFiles.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select>}
          {activeFile?.patch ? <CodeDiffViewer patch={activeFile.patch} path={activeFile.path} /> : <div className="surface-state">当前任务没有可展示的 Diff。</div>}
        </div>}
      </div>
      <PanelResizeHandle ariaLabel="调整评测观察器宽度" edge="left" max={panelMaxWidth} min={360} onChange={onWidthChange} onReset={onWidthReset} value={panelWidth} />
    </aside>
  );
}
