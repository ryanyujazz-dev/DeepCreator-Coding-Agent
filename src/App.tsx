import { Component, CSSProperties, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, PanelRight, SlidersHorizontal, TerminalSquare } from "lucide-react";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { Composer } from "./components/Composer";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Conversation } from "./components/Conversation";
import { SessionSidebar } from "./components/SessionSidebar";
import { Inspector } from "./components/Inspector";
import { Surface, SurfacePane } from "./components/SurfacePane";
import { RuntimeFilePreview, runtimeApi } from "./runtimeApi";
import { useWorkspace } from "./useWorkspace";
import { Changes } from "../shared/contracts/runtime";

type SurfaceFileState = {
  error: string | null;
  file: RuntimeFilePreview | null;
  loading: boolean;
};

const DEFAULT_SIDEBAR_WIDTH = 192;
const DEFAULT_SURFACE_WIDTH = 640;

function storedPanelWidth(key: string, fallback: number): number {
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (!this.state.message) return this.props.children;
    return <main className="workspace app-error-state"><h1>界面渲染遇到问题</h1><p>{this.state.message}</p><button onClick={() => window.location.reload()} type="button">重新加载</button></main>;
  }
}

export function App() {
  const [sidebarWidth, setSidebarWidth] = useState(() => storedPanelWidth("deepseeker.sidebarWidth", DEFAULT_SIDEBAR_WIDTH));
  const [surfaceWidth, setSurfaceWidth] = useState(() => storedPanelWidth("deepseeker.surfaceWidth", DEFAULT_SURFACE_WIDTH));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [surfaceFiles, setSurfaceFiles] = useState<Record<string, SurfaceFileState>>({});
  const [surfaceClosing, setSurfaceClosing] = useState(false);
  const {
    activeRun,
    cancelRun,
    config,
    connection,
    contextObserver,
    currentRun,
    error,
    model,
    newSession,
    pendingApproval,
    accessMode,
    resolveApproval,
    searchSessions,
    selectSession,
    setAccessMode,
    session,
    sessions,
    startRun
  } = useWorkspace();
  const activeStep = currentRun?.plan.find((step) => step.status === "running");
  const workLabel = activeRun
    ? activeStep?.label ?? "Agent 正在处理"
    : currentRun?.status === "failed"
      ? "工作已中断"
      : currentRun?.status === "cancelled"
        ? "工作已取消"
        : "工作已结束";
  const currentDelta = currentRun?.changes.comparisonBase === "run_start"
    ? currentRun.changes
    : { additions: 0, deletions: 0, fileCount: 0 };
  const activeSurface = useMemo(
    () => surfaces.find((candidate) => candidate.id === activeSurfaceId) ?? surfaces[0] ?? null,
    [activeSurfaceId, surfaces]
  );
  const activeFileState = activeSurface?.kind === "file" ? surfaceFiles[activeSurface.path] : undefined;
  const surfaceMaxWidth = Math.max(360, Math.min(960, viewportWidth - sidebarWidth - 420));
  const effectiveSurfaceWidth = Math.min(surfaceWidth, surfaceMaxWidth);
  const openFileSurface = useCallback((filePath: string) => {
    if (!session?.sessionId) return;
    const surfaceId = `file:${filePath}`;
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current
      : [...current, { id: surfaceId, kind: "file", path: filePath }]);
    setActiveSurfaceId(surfaceId);
    setSurfaceFiles((current) => ({
      ...current,
      [filePath]: { error: null, file: current[filePath]?.file ?? null, loading: true }
    }));
    void runtimeApi.getFile(session.sessionId, filePath)
      .then((file) => {
        setSurfaceFiles((current) => ({
          ...current,
          [filePath]: { error: null, file, loading: false }
        }));
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSurfaceFiles((current) => ({
          ...current,
          [filePath]: {
            error: /Route GET:\/api\/sessions\/.+\/files|not found/i.test(message)
              ? "文件读取接口未生效，请重启 Runtime。"
              : message,
            file: current[filePath]?.file ?? null,
            loading: false
          }
        }));
      })
  }, [session]);
  const openReviewSurface = useCallback((delta?: Changes) => {
    const reviewDelta = delta ?? [...(session?.runs ?? [])]
      .reverse()
      .map((run) => run.changes)
      .find((candidate) => candidate.comparisonBase === "run_start" && candidate.fileCount > 0);
    if (!reviewDelta || reviewDelta.comparisonBase !== "run_start" || reviewDelta.fileCount === 0) return;
    const surfaceId = `review:${reviewDelta.files.map((file) => file.path).join("|")}:${reviewDelta.additions}:${reviewDelta.deletions}`;
    const reviewSurface: Surface = { files: reviewDelta.files, id: surfaceId, kind: "review", title: "审阅" };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current.map((candidate) => candidate.id === surfaceId ? reviewSurface : candidate)
      : [...current, reviewSurface]);
    setActiveSurfaceId(surfaceId);
  }, [session?.runs]);
  const closeSurfaceTab = useCallback((surfaceId: string) => {
    setSurfaces((current) => {
      const closingIndex = current.findIndex((candidate) => candidate.id === surfaceId);
      if (closingIndex === -1) return current;
      const next = current.filter((candidate) => candidate.id !== surfaceId);
      if (next.length === 0) {
        setSurfaceClosing(true);
        window.setTimeout(() => {
          setActiveSurfaceId(null);
          setSurfaceClosing(false);
        }, 190);
        return next;
      }
      if (activeSurfaceId === surfaceId) {
        setActiveSurfaceId(next[Math.min(closingIndex, next.length - 1)]?.id ?? next[0].id);
      }
      return next;
    });
  }, [activeSurfaceId]);
  const closeActiveSurface = useCallback(() => {
    if (activeSurfaceId) closeSurfaceTab(activeSurfaceId);
  }, [activeSurfaceId, closeSurfaceTab]);

  useEffect(() => window.localStorage.setItem("deepseeker.sidebarWidth", String(Math.round(sidebarWidth))), [sidebarWidth]);
  useEffect(() => window.localStorage.setItem("deepseeker.surfaceWidth", String(Math.round(surfaceWidth))), [surfaceWidth]);
  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <AppErrorBoundary>
      <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        <SessionSidebar
          onNewSession={newSession}
          onSearch={searchSessions}
          onSelectSession={(sessionId) => void selectSession(sessionId)}
          onWidthChange={setSidebarWidth}
          onWidthReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          selectedSessionKey={session?.sessionId ?? null}
          sidebarWidth={sidebarWidth}
          sessions={sessions}
        />
        <main
          className={`workspace conversation-workspace ${surfaces.length > 0 ? "has-surface" : ""}`}
          style={{ "--surface-width": `${effectiveSurfaceWidth}px` } as CSSProperties}
        >
          <div className="conversation-main">
            <header className="thread-header">
              <div className="thread-title"><TerminalSquare size={16} /><span>{session?.title ?? "DeepSeeker CodeAgent"}</span><MoreHorizontal size={14} /></div>
              <ConnectionStatus phase={connection} />
            </header>
            <div className="window-actions"><button className="icon-button" aria-label="视图设置"><SlidersHorizontal size={14} /></button><button className="icon-button" aria-label="工作区面板"><PanelRight size={14} /></button></div>
            <Inspector onOpenReview={openReviewSurface} session={session} />
            <Conversation onOpenFile={openFileSurface} onOpenReview={openReviewSurface} session={session} />
            <div className="composer-dock">
              {currentRun && (
                <div
                  aria-hidden={!activeRun}
                  className={`composer-hud is-${currentRun.status} ${activeRun ? "is-visible" : "is-collapsed"}`}
                >
                  <span className={activeRun ? "working-glow" : ""}>{activeRun ? "正在执行" : "最近工作"}</span>
                  <strong className={activeRun ? "working-glow" : ""}>{workLabel}</strong>
                  <span>{currentDelta.fileCount} 个文件已更改 <b>+{currentDelta.additions}</b> <i>-{currentDelta.deletions}</i></span>
                </div>
              )}
              {!config?.hasApiKey && config && <div className="composer-notice">未配置 DeepSeek Key，当前使用 <strong>mock-agent</strong></div>}
              {error && <div className="composer-error">{error}</div>}
              <ApprovalDialog approval={pendingApproval} onResolve={(decision) => void resolveApproval(decision)} />
              <Composer
                contextConfig={config}
                contextObserver={contextObserver}
                isRunning={Boolean(activeRun)}
                model={model}
                onCancel={() => void cancelRun()}
                onAccessModeChange={(mode) => void setAccessMode(mode)}
                onSubmit={(prompt) => void startRun(prompt)}
                accessMode={accessMode}
              />
            </div>
          </div>
          <SurfacePane
            activeSurfaceId={activeSurface?.id ?? null}
            file={activeFileState?.file ?? null}
            fileError={activeFileState?.error ?? null}
            fileLoading={activeFileState?.loading ?? false}
            isClosing={surfaceClosing}
            onClose={closeActiveSurface}
            onCloseSurface={closeSurfaceTab}
            onSelectSurface={setActiveSurfaceId}
            onWidthChange={setSurfaceWidth}
            onWidthReset={() => setSurfaceWidth(DEFAULT_SURFACE_WIDTH)}
            panelMaxWidth={() => surfaceMaxWidth}
            panelWidth={effectiveSurfaceWidth}
            surfaces={surfaces}
          />
        </main>
      </div>
    </AppErrorBoundary>
  );
}
