import { Bot, CheckSquare, Copy, ExternalLink, FileCode2, FolderOpen, GitPullRequest, Globe2, Lightbulb, Maximize2, Minimize2, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Changes, FileChange, Plan, Run, isRunDone } from "../../shared/contracts/runtime";
import { RuntimeFilePreview, runtimeApi } from "../runtimeApi";
import { CodeFileViewer, CodeReviewDiffViewer } from "./CodeEditorSurface";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PlanSurface } from "./PlanSurface";
import { MarkdownContent } from "./MarkdownContent";
import { IconButton } from "../shared-ui/ControlPrimitives";
import { desktopBridge } from "../platform/desktop";
import { AgentSurface } from "./AgentSurface";

export type ReviewSurfacePatch = Partial<{ mode: "all" | "round"; selectedPath: string }>;

// "所有变更" 是项目级 git 数据(working tree vs HEAD),只与项目根目录有关、与具体会话无关。
// 因此按项目根目录共享:同一项目的任意会话拉取一次后互相复用,避免每个会话重复请求。
// 仅存在于进程内存,app 退出即清空。
const projectChangesCache = new Map<string, Changes>();

export function clearProjectChanges(projectRoot: string): void {
  projectChangesCache.delete(projectRoot);
}

export type Surface =
  | { id: string; kind: "file"; ownerSessionId: string; path: string }
  | { files: FileChange[]; id: string; kind: "review"; mode?: "all" | "round"; ownerSessionId?: string; projectRoot?: string; selectedPath?: string; title?: string }
  | { callId: string; id: string; kind: "plan"; runId: string; title?: string }
  | { id: string; kind: "browser"; title?: string; url: string }
  | { delegationId: string; id: string; kind: "agent"; sessionId: string; title?: string };

function previewKindForPath(path: string): "markdown" | null {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".md") || normalized.endsWith(".markdown") || normalized.endsWith(".mdx")) {
    return "markdown";
  }
  return null;
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
  const desktop = desktopBridge();
  const [view, setView] = useState<"preview" | "source">("preview");
  if (loading) return <div className="surface-state is-loading working-glow">正在读取文件...</div>;
  if (error) return <div className="surface-state is-error">{error}</div>;
  if (!file) return <div className="surface-state">选择一个文件查看内容。</div>;
  const fileName = file.path.split("/").filter(Boolean).at(-1) ?? file.path;
  const previewKind = previewKindForPath(file.path);
  const effectiveView = previewKind ? view : "source";
  const absolutePath = `${file.projectRoot}/${file.path}`;
  return (
    <>
      <div className="surface-file-header">
        <span className="surface-file-name" title={file.path}>
          <span className="surface-file-name-text">{fileName}</span>
          {file.truncated && <em>内容已截断</em>}
        </span>
        <div className="surface-file-actions">
          {previewKind && (
            <div className="surface-segmented" role="group" aria-label="文件视图">
              <button
                aria-pressed={effectiveView === "preview"}
                className={effectiveView === "preview" ? "is-active" : undefined}
                onClick={() => setView("preview")}
                type="button"
              >
                预览
              </button>
              <button
                aria-pressed={effectiveView === "source"}
                className={effectiveView === "source" ? "is-active" : undefined}
                onClick={() => setView("source")}
                type="button"
              >
                源代码
              </button>
            </div>
          )}
          {desktop && (
            <IconButton label="打开所在文件夹" onClick={() => void desktop.files.reveal(absolutePath)}>
              <FolderOpen size={14} />
            </IconButton>
          )}
          <IconButton label="复制文件内容" onClick={() => void navigator.clipboard?.writeText(file.content)}>
            <Copy size={14} />
          </IconButton>
        </div>
      </div>
      {effectiveView === "preview" && previewKind === "markdown" ? (
        <div className="surface-markdown-host">
          <MarkdownContent text={file.content} />
        </div>
      ) : (
        <CodeFileViewer content={file.content} modelPath={absolutePath} path={file.path} />
      )}
    </>
  );
}

function ReviewSurface({
  onUpdate,
  surface
}: {
  onUpdate: (surfaceId: string, patch: ReviewSurfacePatch) => void;
  surface: Extract<Surface, { kind: "review" }>;
}) {
  const { files, ownerSessionId } = surface;
  const mode = surface.mode ?? "round";
  const [allChanges, setAllChanges] = useState<{
    data?: Changes;
    error: string | null;
    status: "error" | "idle" | "loading" | "success";
  }>(() => {
    const cached = surface.projectRoot ? projectChangesCache.get(surface.projectRoot) : undefined;
    return cached ? { data: cached, error: null, status: "success" } : { error: null, status: "idle" };
  });
  useEffect(() => {
    if (mode !== "all" || !ownerSessionId || allChanges.status !== "idle") return;
    setAllChanges({ error: null, status: "loading" });
    void runtimeApi
      .getChanges(ownerSessionId)
      .then((data) => {
        setAllChanges({ data, error: null, status: "success" });
        if (surface.projectRoot) projectChangesCache.set(surface.projectRoot, data);
      })
      .catch((nextError) => setAllChanges({ error: nextError instanceof Error ? nextError.message : String(nextError), status: "error" }));
  }, [mode, ownerSessionId, surface.projectRoot, surface.id, allChanges.status, onUpdate]);

  // 清 projectChangesCache + 重置 idle → 上面 fetch effect 自动重拉最新 git(working tree vs HEAD)。
  // 只影响 all 模式(round 模式 effect 守卫 mode==="all" 不 fetch,refresh 无副作用)。
  const refresh = useCallback(() => {
    if (surface.projectRoot) clearProjectChanges(surface.projectRoot);
    setAllChanges({ data: undefined, error: null, status: "idle" });
  }, [surface.projectRoot]);

  // 打开即拉最新(不显示旧 cache)+ 窗口聚焦/从后台切回时重拉(IDE/git 改完切回自动刷新)。
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const handleModeChange = (next: "all" | "round") => {
    onUpdate(surface.id, { mode: next });
    if (next === "all" && allChanges.status === "error") {
      setAllChanges({ error: null, status: "idle" });
    }
  };

  const activeFiles = useMemo(
    () => (mode === "round" ? files : allChanges.data?.files ?? []),
    [mode, files, allChanges.data]
  );
  const combinedPatch = useMemo(
    () => activeFiles.map((item) => item.patch).filter(Boolean).join("\n\n"),
    [activeFiles]
  );
  const totals = useMemo(
    () => activeFiles.reduce(
      (sum, item) => ({ additions: sum.additions + item.additions, deletions: sum.deletions + item.deletions }),
      { additions: 0, deletions: 0 }
    ),
    [activeFiles]
  );
  return (
    <>
      <div className="surface-review-toolbar">
        <div>
          <div className="surface-segmented" role="group" aria-label="变更范围">
            <button
              aria-pressed={mode === "all"}
              className={mode === "all" ? "is-active" : undefined}
              disabled={!ownerSessionId}
              onClick={() => handleModeChange("all")}
              type="button"
            >
              所有变更
            </button>
            <button
              aria-pressed={mode === "round"}
              className={mode === "round" ? "is-active" : undefined}
              onClick={() => handleModeChange("round")}
              type="button"
            >
              本轮变更
            </button>
          </div>
          <span><b>+{totals.additions}</b> <i>-{totals.deletions}</i></span>
        </div>
        <div className="surface-review-actions">
          <IconButton label="刷新 diff" onClick={refresh}><RefreshCw size={14} /></IconButton>
          <IconButton label="更多审阅操作"><MoreHorizontal size={14} /></IconButton>
          <IconButton label="审阅设置"><GitPullRequest size={14} /></IconButton>
          <IconButton label="复制 diff" onClick={() => void navigator.clipboard?.writeText(combinedPatch)}><Copy size={14} /></IconButton>
        </div>
      </div>
      {mode === "all" && allChanges.status === "loading" ? (
        <div className="surface-state is-loading working-glow">正在读取所有变更...</div>
      ) : mode === "all" && allChanges.status === "error" ? (
        <div className="surface-state is-error">{allChanges.error}</div>
      ) : activeFiles.length === 0 ? (
        <div className="surface-state">{mode === "all" ? "自上次提交后没有变更。" : "本轮没有文件变更。"}</div>
      ) : combinedPatch ? (
        <CodeReviewDiffViewer patch={combinedPatch} />
      ) : (
        <div className="surface-state">这些文件没有可展示的 diff。</div>
      )}
    </>
  );
}

function BrowserSurface({ surface }: { surface: Extract<Surface, { kind: "browser" }> }) {
  const desktop = desktopBridge();
  return (
    <div className="surface-state">
      <Globe2 size={15} />
      <span>{surface.url}</span>
      {desktop && <IconButton label="在默认浏览器中打开" onClick={() => void desktop.files.openExternal(surface.url)}><ExternalLink size={14} /></IconButton>}
    </div>
  );
}

function surfaceTitle(surface: Surface): string {
  if (surface.kind === "file") return surface.path.split("/").filter(Boolean).at(-1) ?? "文件";
  if (surface.kind === "review") return surface.title ?? "审阅";
  if (surface.kind === "plan") return surface.title ?? "计划";
  if (surface.kind === "agent") return surface.title ?? "子代理";
  return surface.title ?? surface.url;
}

function surfaceIcon(surface: Surface) {
  if (surface.kind === "review") return <CheckSquare size={13} />;
  if (surface.kind === "plan") return <Lightbulb size={13} />;
  if (surface.kind === "browser") return <Globe2 size={13} />;
  if (surface.kind === "agent") return <Bot size={13} />;
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
  onOpenFile,
  onOpenReview,
  onUpdateReview,
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
  onOpenFile: (path: string, ownerSessionId: string) => void;
  onOpenReview: (delta: Changes, ownerSessionId?: string) => void;
  onUpdateReview: (surfaceId: string, patch: ReviewSurfacePatch) => void;
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);
  const isEmpty = surfaces.length === 0;
  const surface = isEmpty ? null : surfaces.find((candidate) => candidate.id === activeSurfaceId) ?? surfaces[0];
  const planRun = surface?.kind === "plan" ? runs.find((run) => run.runId === surface.runId) : undefined;
  return (
    <aside className={`workspace-surface-panel ${isClosing ? "is-closing" : "is-open"} ${isFullscreen ? "is-fullscreen" : ""}`} aria-label="工作区侧栏">
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
            <div className={`surface-tab ${candidate.id === surface?.id ? "is-active" : ""}`} key={candidate.id}>
              <button
                aria-selected={candidate.id === surface?.id}
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
          <IconButton
            aria-pressed={isFullscreen}
            label={isFullscreen ? "还原工作区" : "展开工作区"}
            onClick={() => setIsFullscreen((value) => !value)}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </IconButton>
          <IconButton label="关闭工作区侧栏" onClick={onClose}><X size={16} /></IconButton>
        </div>
      </header>
      {isEmpty ? (
        <div className="surface-state surface-state-empty">工作区为空。打开的文件、计划与审阅会显示在这里。</div>
      ) : surface?.kind === "file"
        ? <FileSurface error={fileError} file={file} loading={fileLoading} />
        : surface?.kind === "review"
          ? <ReviewSurface key={surface.id} onUpdate={onUpdateReview} surface={surface} />
          : surface?.kind === "plan"
            ? <PlanSurface
                activity={planRun?.activities.find((activity) => activity.tool?.callId === surface.callId)}
                onRevise={onRevisePlan}
                plan={plans.filter((plan) => plan.runId === surface.runId && plan.callId === surface.callId).sort((left, right) => right.revision - left.revision)[0]}
                runActive={Boolean(planRun && !isRunDone(planRun.status))}
              />
            : surface?.kind === "agent"
              ? <AgentSurface
                  key={surface.sessionId}
                  onOpenFile={(path) => onOpenFile(path, surface.sessionId)}
                  onOpenReview={(delta) => onOpenReview(delta, surface.sessionId)}
                  surface={surface}
                />
              : surface?.kind === "browser"
                ? <BrowserSurface surface={surface} />
                : null}
    </aside>
  );
}
