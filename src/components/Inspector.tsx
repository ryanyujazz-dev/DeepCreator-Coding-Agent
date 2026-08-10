import { ChevronDown, ChevronLeft, ChevronRight, FileCode2, FileText, Image, Lightbulb, Maximize2, Sparkles, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { ArtifactEntry, Session } from "../../shared/contracts/runtime";
import { ConnectionPhase } from "./ConnectionStatus";
import { IconButton } from "../shared-ui/ControlPrimitives";
import { ReasoningTrace } from "./ReasoningTrace";
import { TaskPanel } from "./TaskPanel";
import { useTaskHistory } from "../features/runtime/useTaskHistory";
import { desktopBridge } from "../platform/desktop";
import { runtimeApi } from "../runtimeApi";

type CollapsibleSection = "task" | "plan" | "output";

const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function artifactIcon(path: string) {
  if (MARKDOWN_RE.test(path)) return FileText;
  if (IMAGE_RE.test(path)) return Image;
  return FileCode2;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function Inspector({
  compact,
  connection,
  onOpenFile,
  onOpenPlan,
  session
}: {
  compact: boolean;
  connection: ConnectionPhase;
  onOpenFile: (path: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  session: Session | null;
}) {
  const run = session?.runs.at(-1);
  const { current, history } = useTaskHistory(session);
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

  // 产物文件列表:扫描项目 output/ 目录,按 projectRoot 跨会话共享。run 状态变化(完成)/切会话时刷新。
  const sessionId = session?.sessionId;
  const runStatus = run?.status;
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  useEffect(() => {
    if (!sessionId) { setArtifacts([]); return; }
    let cancelled = false;
    void runtimeApi.getArtifacts(sessionId)
      .then((data) => { if (!cancelled) setArtifacts(data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, runStatus]);

  const capsuleSummary = activeTask
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
  const projectRoot = session?.projectRoot;
  const openArtifact = (relativePath: string) => {
    if (MARKDOWN_RE.test(relativePath)) {
      // md 走内置 FileSurface 渲染(MarkdownContent);路径相对 projectRoot,产物在 output/ 下。
      onOpenFile(`output/${relativePath}`);
      return;
    }
    // 其他类型(pdf/jpg/png/html 等)用系统默认程序打开(需桌面环境;浏览器/无桌面时静默 no-op)。
    if (projectRoot) {
      void desktopBridge()?.files.openPath(`${projectRoot}/output/${relativePath}`);
    }
  };
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
          </header>
          {!collapsed.task && <TaskPanel current={current} history={history} />}
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
          </header>
          {!collapsed.output && (artifacts.length > 0 ? (
            <div className="output-file-list">
              {artifacts.map((file) => {
                const ArtifactIcon = artifactIcon(file.path);
                return (
                  <button
                    className="environment-row output-file-row"
                    key={file.path}
                    onClick={() => openArtifact(file.path)}
                    title={file.path}
                    type="button"
                  >
                    <ArtifactIcon size={15} />
                    <span className="output-file-path">{file.path}</span>
                    <small className="output-file-stats">{formatSize(file.size)}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="environment-row is-muted">
              <FileCode2 size={15} />
              <span>尚无产物文件(output/ 目录为空)</span>
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
