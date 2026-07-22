import { CheckSquare, Copy, ExternalLink, FileCode2, FolderOpen, GitPullRequest, Globe2, Lightbulb, Maximize2, Minus, MoreHorizontal, PanelRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FileChange, Plan, Run, isRunDone } from "../../shared/contracts/runtime";
import { RuntimeFilePreview } from "../runtimeApi";
import { CodeDiffViewer, CodeFileViewer } from "./CodeEditorSurface";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PlanSurface } from "./PlanSurface";
import { IconButton, RowAction } from "../shared-ui/ControlPrimitives";

export type Surface =
  | { id: string; kind: "file"; path: string }
  | { files: FileChange[]; id: string; kind: "review"; selectedPath?: string; title?: string }
  | { callId: string; id: string; kind: "plan"; runId: string; title?: string }
  | { id: string; kind: "browser"; title?: string; url: string };

function fileBreadcrumbs(file: RuntimeFilePreview): string[] {
  return file.path.split("/").filter(Boolean);
}

function FileSurface({
  error,
  file,
  loading
}: {
  error: string | null;
  file: RuntimeFilePreview | null;
  loading: boolean;
}) {
  const parts = file ? fileBreadcrumbs(file) : [];
  if (loading) return <div className="surface-state is-loading working-glow">正在读取文件...</div>;
  if (error) return <div className="surface-state is-error">{error}</div>;
  if (!file) return <div className="surface-state">选择一个文件查看内容。</div>;
  return (
    <>
      <nav className="surface-breadcrumbs" aria-label="文件路径">
        {parts.map((part, index) => (
          <span key={`${index}-${part}`}>{part}</span>
        ))}
      </nav>
      <div className="surface-toolbar">
        <span>{file.truncated ? "内容已截断" : "只读预览"}</span>
        {window.deepseeker && <IconButton label="在 Finder 中显示" onClick={() => void window.deepseeker?.files.reveal(`${file.projectRoot}/${file.path}`)}><FolderOpen size={13} /></IconButton>}
        <IconButton
          label="复制文件内容"
          onClick={() => void navigator.clipboard?.writeText(file.content)}
        >
          <Copy size={13} />
        </IconButton>
      </div>
      <CodeFileViewer content={file.content} modelPath={`${file.projectRoot}/${file.path}`} path={file.path} />
    </>
  );
}

function ReviewSurface({
  files,
  selectedPath
}: {
  files: FileChange[];
  selectedPath?: string;
}) {
  const [activePath, setActivePath] = useState(selectedPath ?? files[0]?.path ?? "");
  useEffect(() => {
    setActivePath(selectedPath ?? files[0]?.path ?? "");
  }, [files, selectedPath]);
  const activeFile = useMemo(
    () => files.find((item) => item.path === activePath) ?? files[0],
    [activePath, files]
  );
  const totals = files.reduce(
    (sum, item) => ({ additions: sum.additions + item.additions, deletions: sum.deletions + item.deletions }),
    { additions: 0, deletions: 0 }
  );
  return (
    <>
      <div className="surface-review-toolbar">
        <div>
          <strong>上一轮</strong>
          <span><b>+{totals.additions}</b> <i>-{totals.deletions}</i></span>
        </div>
        <div className="surface-review-actions">
          <IconButton label="更多审阅操作"><MoreHorizontal size={14} /></IconButton>
          <IconButton label="审阅设置"><GitPullRequest size={14} /></IconButton>
          <IconButton label="复制当前 diff" onClick={() => void navigator.clipboard?.writeText(activeFile?.patch ?? "")}><Copy size={14} /></IconButton>
        </div>
      </div>
      <div className="surface-review-files">
        {files.map((item) => (
          <RowAction
            className={`surface-review-file ${item.path === activeFile?.path ? "is-active" : ""}`}
            key={item.path}
            onClick={() => setActivePath(item.path)}
            title={item.path}
          >
            <FileCode2 size={13} />
            <span>{item.path}</span>
            <strong><b>+{item.additions}</b> <i>-{item.deletions}</i></strong>
          </RowAction>
        ))}
      </div>
      {activeFile?.patch ? (
        <CodeDiffViewer patch={activeFile.patch} path={activeFile.path} />
      ) : (
        <div className="surface-state">这个文件没有可展示的 diff。</div>
      )}
    </>
  );
}

function BrowserSurface({ surface }: { surface: Extract<Surface, { kind: "browser" }> }) {
  return (
    <div className="surface-state">
      <Globe2 size={15} />
      <span>{surface.url}</span>
      {window.deepseeker && <IconButton label="在默认浏览器中打开" onClick={() => void window.deepseeker?.files.openExternal(surface.url)}><ExternalLink size={14} /></IconButton>}
    </div>
  );
}

function surfaceTitle(surface: Surface): string {
  if (surface.kind === "file") return surface.path.split("/").filter(Boolean).at(-1) ?? "文件";
  if (surface.kind === "review") return surface.title ?? "审阅";
  if (surface.kind === "plan") return surface.title ?? "计划";
  return surface.title ?? surface.url;
}

function surfaceIcon(surface: Surface) {
  if (surface.kind === "review") return <CheckSquare size={13} />;
  if (surface.kind === "plan") return <Lightbulb size={13} />;
  if (surface.kind === "browser") return <Globe2 size={13} />;
  return <FileCode2 size={13} />;
}

export function SurfacePane({
  activeSurfaceId,
  file,
  fileError,
  fileLoading,
  isClosing = false,
  onClose,
  onCloseSurface,
  onRevisePlan,
  onSelectSurface,
  onWidthChange,
  onWidthReset,
  panelMaxWidth,
  panelWidth,
  surfaces,
  plans,
  runs
}: {
  activeSurfaceId: string | null;
  file: RuntimeFilePreview | null;
  fileError: string | null;
  fileLoading: boolean;
  isClosing?: boolean;
  onClose: () => void;
  onCloseSurface: (surfaceId: string) => void;
  onRevisePlan: (plan: Plan, title: string, markdown: string) => Promise<void> | void;
  onSelectSurface: (surfaceId: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  panelMaxWidth: () => number;
  panelWidth: number;
  surfaces: Surface[];
  plans: Plan[];
  runs: Run[];
}) {
  if (surfaces.length === 0) return null;
  const surface = surfaces.find((candidate) => candidate.id === activeSurfaceId) ?? surfaces[0];
  const planRun = surface.kind === "plan" ? runs.find((run) => run.runId === surface.runId) : undefined;
  return (
    <aside className={`workspace-surface-panel ${isClosing ? "is-closing" : "is-open"}`} aria-label="工作区侧栏">
      <PanelResizeHandle
        ariaLabel="调整右侧栏宽度"
        edge="left"
        max={panelMaxWidth}
        min={360}
        onChange={onWidthChange}
        onReset={onWidthReset}
        value={panelWidth}
      />
      <header className="surface-tab-strip">
        <div className="surface-tabs">
          {surfaces.map((candidate) => (
            <div className={`surface-tab ${candidate.id === surface.id ? "is-active" : ""}`} key={candidate.id}>
              <button
                aria-selected={candidate.id === surface.id}
                className="surface-tab-main"
                onClick={() => onSelectSurface(candidate.id)}
                title={surfaceTitle(candidate)}
                type="button"
              >
                {surfaceIcon(candidate)}
                <span>{surfaceTitle(candidate)}</span>
              </button>
              <IconButton
                label={`关闭 ${surfaceTitle(candidate)}`}
                className="surface-tab-close"
                onClick={() => onCloseSurface(candidate.id)}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="surface-window-actions">
          <IconButton label="新建标签"><Plus size={14} /></IconButton>
          <IconButton label="展开工作区"><Maximize2 size={13} /></IconButton>
          <IconButton label="最小化工作区"><Minus size={14} /></IconButton>
          <IconButton label="切换侧栏布局"><PanelRight size={14} /></IconButton>
          <IconButton label="关闭工作区侧栏" onClick={onClose}><X size={14} /></IconButton>
        </div>
      </header>
      {surface.kind === "file"
        ? <FileSurface error={fileError} file={file} loading={fileLoading} />
        : surface.kind === "review"
          ? <ReviewSurface files={surface.files} selectedPath={surface.selectedPath} />
          : surface.kind === "plan"
            ? <PlanSurface
                activity={planRun?.activities.find((activity) => activity.tool?.callId === surface.callId)}
                onRevise={onRevisePlan}
                plan={plans.filter((plan) => plan.runId === surface.runId && plan.callId === surface.callId).sort((left, right) => right.revision - left.revision)[0]}
                runActive={Boolean(planRun && !isRunDone(planRun.status))}
              />
            : <BrowserSurface surface={surface} />}
    </aside>
  );
}
