import { ChevronLeft, ChevronRight, FileCode2, FileText, Lightbulb, Sparkles, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { Changes, Session } from "../../shared/contracts/runtime";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { RuntimeWorkspace } from "../runtimeApi";
import { ConnectionPhase } from "./ConnectionStatus";
import { IconButton } from "../shared-ui/ControlPrimitives";
import { ReasoningTrace } from "./ReasoningTrace";

export function Inspector({
  compact,
  connection,
  onOpenPlan,
  onOpenReview,
  session,
  workspace
}: {
  compact: boolean;
  connection: ConnectionPhase;
  onOpenPlan: (runId: string, callId: string) => void;
  onOpenReview: (delta?: Changes) => void;
  session: Session | null;
  workspace: RuntimeWorkspace | null;
}) {
  const run = session?.runs.at(-1);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const connectionLabel = {
    connected: "Runtime 已连接",
    connecting: "正在连接 Runtime",
    offline: "Runtime 离线",
    reconnecting: "正在恢复连接"
  }[connection];
  const activeTask = run?.tasks.find((task) => task.status === "running");
  const latestPlan = session?.plans.at(-1);
  const changeCount = run?.changes.comparisonBase === "run_start"
    ? run.changes.fileCount
    : 0;
  const capsuleSummary = changeCount > 0
    ? { icon: <FileCode2 size={13} />, label: `${changeCount} 个文件变更`, tone: "changes" }
    : activeTask
      ? { icon: <Sparkles size={13} />, label: activeTask.label, tone: "task" }
      : { icon: <Wifi size={13} />, label: connectionLabel, tone: connection };

  useEffect(() => {
    if (!compact) setOverlayOpen(false);
  }, [compact]);

  useEffect(() => {
    if (!overlayOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlayOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [overlayOpen]);

  const collapsed = compact && !overlayOpen;
  return (
    <aside
      className={`environment-panel${collapsed ? " is-capsule" : ""}${compact && overlayOpen ? " is-overlay-open" : ""}`}
      aria-label="工作区信息"
    >
      <div className={`environment-capsule is-${capsuleSummary.tone}`}>
        <span className="environment-capsule-icon" aria-hidden="true">{capsuleSummary.icon}</span>
        <span>{capsuleSummary.label}</span>
        <IconButton
          aria-expanded={false}
          className="environment-expand-button"
          label="展开运行环境"
          onClick={() => setOverlayOpen(true)}
        >
          <ChevronLeft size={14} />
        </IconButton>
      </div>
      <div className="environment-panel-content">
        <section className="environment-section plan-section">
          <header><span>计划</span></header>
          {latestPlan ? (
            <button
              className="environment-row environment-plan-document"
              onClick={() => onOpenPlan(latestPlan.runId, latestPlan.callId)}
              type="button"
            >
              <Lightbulb size={15} />
              <span>
                <strong>{latestPlan.title}</strong>
                <small>第 {latestPlan.revision} 版 · {{
                  approved: "已批准",
                  draft: "草稿",
                  proposed: "待审阅",
                  rejected: "已退回",
                  superseded: "旧版本"
                }[latestPlan.status]}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          ) : (
            <div className="environment-row is-muted">
              <FileText size={15} />
              <span>尚未创建计划文档</span>
            </div>
          )}
        </section>
        <EnvironmentPanel onOpenReview={onOpenReview} session={session} workspace={workspace} />
        <ReasoningTrace run={run} />
      </div>
      {compact && overlayOpen && (
        <IconButton
          aria-expanded
          className="environment-collapse-button"
          label="收起运行环境"
          onClick={() => setOverlayOpen(false)}
        >
          <ChevronRight size={14} />
        </IconButton>
      )}
    </aside>
  );
}
