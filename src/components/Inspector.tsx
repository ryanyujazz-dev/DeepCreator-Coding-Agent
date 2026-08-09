import { ArrowRightLeft, ChevronDown, ChevronLeft, ChevronRight, FileCode2, FilePenLine, FilePlus2, FileText, Lightbulb, Maximize2, Sparkles, Trash2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { Changes, FileChange, Session, Task } from "../../shared/contracts/runtime";
import { ConnectionPhase } from "./ConnectionStatus";
import { IconButton } from "../shared-ui/ControlPrimitives";
import { ReasoningTrace } from "./ReasoningTrace";
import { TaskPanel } from "./TaskPanel";

const OUTPUT_OPERATION_ICONS = {
  created: FilePlus2,
  edited: FilePenLine,
  deleted: Trash2,
  renamed: ArrowRightLeft,
  unknown: FileCode2
} as const;

type CollapsibleSection = "task" | "plan" | "output";

export function Inspector({
  compact,
  connection,
  onOpenFile,
  onOpenPlan,
  onOpenReview,
  session,
  taskActive,
  taskLabel,
  tasks
}: {
  compact: boolean;
  connection: ConnectionPhase;
  onOpenFile: (path: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  onOpenReview: (delta?: Changes) => void;
  session: Session | null;
  taskActive: boolean;
  taskLabel: string;
  tasks: Task[];
}) {
  const run = session?.runs.at(-1);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<CollapsibleSection, boolean>>({
    task: false,
    plan: false,
    output: false
  });
  const toggleSection = (key: CollapsibleSection) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const connectionLabel = {
    connected: "Runtime 已连接",
    connecting: "正在连接 Runtime",
    offline: "Runtime 离线",
    reconnecting: "正在恢复连接"
  }[connection];
  const activeTask = run?.tasks.find((task) => task.status === "running");
  const latestPlan = session?.plans.at(-1);
  const outputFiles: FileChange[] = run?.changes.files ?? [];
  const delta = run?.changes.comparisonBase === "run_start" ? run.changes : undefined;
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

  const collapsedNow = compact && !overlayOpen;
  return (
    <aside
      className={`environment-panel${collapsedNow ? " is-capsule" : ""}${compact && overlayOpen ? " is-overlay-open" : ""}`}
      aria-label="工作区信息"
    >
      <div className={`environment-capsule is-${capsuleSummary.tone}`}>
        <span className="environment-capsule-icon" aria-hidden="true">{capsuleSummary.icon}</span>
        <span>{capsuleSummary.label}</span>
        <IconButton
          aria-expanded={false}
          className="environment-expand-button"
          label="展开面板"
          onClick={() => setOverlayOpen(true)}
        >
          <ChevronLeft size={14} />
        </IconButton>
      </div>
      <div className="environment-panel-content">
        <section className={`environment-section task-section ${collapsed.task ? "is-collapsed" : "is-expanded"}`}>
          <header>
            <button aria-expanded={!collapsed.task} className="environment-section-toggle" onClick={() => toggleSection("task")} type="button">
              <span>任务</span>
              <ChevronDown size={13} />
            </button>
            {taskActive && taskLabel ? <small>{taskLabel}</small> : null}
          </header>
          {!collapsed.task && <TaskPanel tasks={tasks} />}
        </section>
        <section className={`environment-section plan-section ${collapsed.plan ? "is-collapsed" : "is-expanded"}`}>
          <header>
            <button aria-expanded={!collapsed.plan} className="environment-section-toggle" onClick={() => toggleSection("plan")} type="button">
              <span>计划</span>
              <ChevronDown size={13} />
            </button>
          </header>
          {!collapsed.plan && (latestPlan ? (
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
          ))}
        </section>
        <section className={`environment-section output-section ${collapsed.output ? "is-collapsed" : "is-expanded"}`}>
          <header>
            <button aria-expanded={!collapsed.output} className="environment-section-toggle" onClick={() => toggleSection("output")} type="button">
              <span>输出</span>
              <ChevronDown size={13} />
            </button>
            {outputFiles.length > 0 && delta ? (
              <button className="output-review-link" onClick={() => onOpenReview(delta)} type="button">查看差异</button>
            ) : null}
          </header>
          {!collapsed.output && (outputFiles.length > 0 ? (
            <div className="output-file-list">
              {outputFiles.map((file) => {
                const OperationIcon = OUTPUT_OPERATION_ICONS[file.operation] ?? FileCode2;
                return (
                  <button
                    className="environment-row output-file-row"
                    key={file.path}
                    onClick={() => onOpenFile(file.path)}
                    title={file.path}
                    type="button"
                  >
                    <OperationIcon size={15} />
                    <span className="output-file-path">{file.path}</span>
                    {file.additions > 0 || file.deletions > 0 ? (
                      <small className="output-file-stats">+{file.additions} −{file.deletions}</small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="environment-row is-muted">
              <FileCode2 size={15} />
              <span>尚无输出文件</span>
            </div>
          ))}
        </section>
        <ReasoningTrace run={run} />
      </div>
      {compact && overlayOpen && (
        <IconButton
          aria-expanded
          className="environment-collapse-button"
          label="收起面板"
          onClick={() => setOverlayOpen(false)}
        >
          <Maximize2 size={15} />
        </IconButton>
      )}
    </aside>
  );
}
