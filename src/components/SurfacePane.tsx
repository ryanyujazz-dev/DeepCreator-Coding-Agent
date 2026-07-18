import { CheckSquare, Copy, FileCode2, GitPullRequest, Globe2, Lightbulb, Maximize2, Minus, MoreHorizontal, PanelRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AccessMode, FileChange, Plan, PlanDecision, Question } from "../../shared/contracts/runtime";
import { RuntimeFilePreview } from "../runtimeApi";
import { CodeDiffViewer, CodeFileViewer } from "./CodeEditorSurface";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PlanSurface } from "./PlanSurface";

export type Surface =
  | { id: string; kind: "file"; path: string }
  | { files: FileChange[]; id: string; kind: "review"; selectedPath?: string; title?: string }
  | { id: string; kind: "plan"; runId: string; title?: string }
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
        <button
          aria-label="复制文件内容"
          onClick={() => void navigator.clipboard?.writeText(file.content)}
          type="button"
        >
          <Copy size={13} />
        </button>
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
          <button aria-label="更多审阅操作" type="button"><MoreHorizontal size={14} /></button>
          <button aria-label="审阅设置" type="button"><GitPullRequest size={14} /></button>
          <button aria-label="复制当前 diff" onClick={() => void navigator.clipboard?.writeText(activeFile?.patch ?? "")} type="button"><Copy size={14} /></button>
        </div>
      </div>
      <div className="surface-review-files">
        {files.map((item) => (
          <button
            className={`surface-review-file ${item.path === activeFile?.path ? "is-active" : ""}`}
            key={item.path}
            onClick={() => setActivePath(item.path)}
            title={item.path}
            type="button"
          >
            <FileCode2 size={13} />
            <span>{item.path}</span>
            <strong><b>+{item.additions}</b> <i>-{item.deletions}</i></strong>
          </button>
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
  accessMode,
  file,
  fileError,
  fileLoading,
  isClosing = false,
  onClose,
  onCloseSurface,
  onAnswerQuestion,
  onResolvePlan,
  onRevisePlan,
  onSelectSurface,
  onWidthChange,
  onWidthReset,
  panelMaxWidth,
  panelWidth,
  surfaces,
  plans,
  questions
}: {
  activeSurfaceId: string | null;
  accessMode: AccessMode;
  file: RuntimeFilePreview | null;
  fileError: string | null;
  fileLoading: boolean;
  isClosing?: boolean;
  onClose: () => void;
  onCloseSurface: (surfaceId: string) => void;
  onAnswerQuestion: (interactionId: string, answers: Record<string, string>) => Promise<void> | void;
  onResolvePlan: (plan: Plan, decision: PlanDecision, comments?: string, nextAccessMode?: AccessMode) => Promise<void> | void;
  onRevisePlan: (plan: Plan, title: string, markdown: string) => Promise<void> | void;
  onSelectSurface: (surfaceId: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  panelMaxWidth: () => number;
  panelWidth: number;
  surfaces: Surface[];
  plans: Plan[];
  questions: Question[];
}) {
  if (surfaces.length === 0) return null;
  const surface = surfaces.find((candidate) => candidate.id === activeSurfaceId) ?? surfaces[0];
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
              <button
                aria-label={`关闭 ${surfaceTitle(candidate)}`}
                className="surface-tab-close"
                onClick={() => onCloseSurface(candidate.id)}
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="surface-window-actions">
          <button aria-label="新建标签" type="button"><Plus size={14} /></button>
          <button aria-label="展开工作区" type="button"><Maximize2 size={13} /></button>
          <button aria-label="最小化工作区" type="button"><Minus size={14} /></button>
          <button aria-label="切换侧栏布局" type="button"><PanelRight size={14} /></button>
          <button aria-label="关闭工作区侧栏" onClick={onClose} type="button"><X size={14} /></button>
        </div>
      </header>
      {surface.kind === "file"
        ? <FileSurface error={fileError} file={file} loading={fileLoading} />
        : surface.kind === "review"
          ? <ReviewSurface files={surface.files} selectedPath={surface.selectedPath} />
          : surface.kind === "plan"
            ? <PlanSurface
                accessMode={accessMode}
                onAnswerQuestion={onAnswerQuestion}
                onResolve={onResolvePlan}
                onRevise={onRevisePlan}
                plans={plans.filter((plan) => plan.runId === surface.runId)}
                question={[...questions].reverse().find((question) => question.runId === surface.runId)}
              />
            : <BrowserSurface surface={surface} />}
    </aside>
  );
}
