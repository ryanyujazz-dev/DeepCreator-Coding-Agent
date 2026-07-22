import { Component, CSSProperties, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Folder, MoreHorizontal, PanelRight, SlidersHorizontal } from "lucide-react";
import { AppTopbar } from "./components/AppTopbar";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { Composer } from "./components/Composer";
import { ProjectContextSelector } from "./components/ProjectContextSelector";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Conversation } from "./components/Conversation";
import { SessionSidebar } from "./components/SessionSidebar";
import { Inspector } from "./components/Inspector";
import { Surface, SurfacePane } from "./components/SurfacePane";
import { RuntimeFilePreview, runtimeApi } from "./runtimeApi";
import { useWorkspace } from "./useWorkspace";
import { Changes } from "../shared/contracts/runtime";
import { ProjectRef } from "../shared/contracts/desktop";
import { SettingsDialog } from "./components/SettingsDialog";
import { IconButton } from "./components/ui/ControlPrimitives";
import { defaultDraftWorkspace, DraftWorkspace, projectDraftWorkspace } from "./workspaceSelection";

type SurfaceFileState = {
  error: string | null;
  file: RuntimeFilePreview | null;
  loading: boolean;
};

const DEFAULT_SIDEBAR_WIDTH = 272;
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(DEFAULT_SIDEBAR_WIDTH, storedPanelWidth("deepseeker.sidebarWidth", DEFAULT_SIDEBAR_WIDTH)));
  const [surfaceWidth, setSurfaceWidth] = useState(() => storedPanelWidth("deepseeker.surfaceWidth", DEFAULT_SURFACE_WIDTH));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [surfaceFiles, setSurfaceFiles] = useState<Record<string, SurfaceFileState>>({});
  const [surfaceClosing, setSurfaceClosing] = useState(false);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [projectsReady, setProjectsReady] = useState(!window.deepseeker);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const desktop = window.deepseeker;
  const {
    activeRun,
    archiveProjectSessions,
    archiveSession,
    cancelRun,
    config,
    connection,
    contextObserver,
    currentRun,
    draftRevision,
    draftWorkspace,
    balance,
    error,
    model,
    mode,
    newSession,
    pendingApproval,
    pinSession,
    reportError,
    accessMode,
    resolveApproval,
    resolvePlan,
    revisePlan,
    answerQuestion,
    searchSessions,
    selectSession,
    setAccessMode,
    setDraftWorkspace,
    setMode,
    session,
    sessions,
    startRun,
    stopCommand,
    retryRuntime,
    workspace
  } = useWorkspace();
  const activeTask = (currentRun?.tasks ?? []).find((task) => task.status === "running");
  const waitingRun = activeRun?.status === "waiting" ? activeRun : undefined;
  const pendingPlan = waitingRun
    ? [...(session?.plans ?? [])].reverse().find((plan) => plan.runId === waitingRun.runId && plan.status === "proposed")
    : undefined;
  const pendingQuestion = waitingRun
    ? [...(session?.questions ?? [])].reverse().find((question) => question.runId === waitingRun.runId && question.status === "pending")
    : undefined;
  const agentRunning = Boolean(activeRun && activeRun.status !== "waiting");
  const workLabel = waitingRun
    ? pendingPlan
      ? "等待方案审阅"
      : "等待你的回答"
    : activeRun
      ? activeTask?.label ?? "Agent 正在处理"
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
  const compactWorkspace = viewportWidth <= 760;
  const visibleSidebarWidth = compactWorkspace ? 0 : sidebarWidth;
  const conversationMinimum = compactWorkspace ? 280 : 420;
  const surfaceMinimum = compactWorkspace ? 280 : 360;
  const surfaceWidthCap = compactWorkspace ? 420 : 960;
  const surfaceMaxWidth = Math.max(surfaceMinimum, Math.min(surfaceWidthCap, viewportWidth - visibleSidebarWidth - conversationMinimum));
  const effectiveSurfaceWidth = Math.min(surfaceWidth, surfaceMaxWidth);
  const selectableProjects = useMemo<ProjectRef[]>(() => {
    if (desktop || !config?.workspaceRoot) return projects;
    const name = config.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? config.workspaceRoot;
    return [{ lastOpenedAt: "", name, path: config.workspaceRoot }, ...projects.filter((project) => project.path !== config.workspaceRoot)];
  }, [config?.workspaceRoot, desktop, projects]);
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
  const openPlanSurface = useCallback((runId: string, callId: string) => {
    const plan = [...(session?.plans ?? [])].reverse().find((candidate) => candidate.runId === runId && candidate.callId === callId);
    const surface: Surface = {
      callId,
      id: `plan:${runId}:${callId}`,
      kind: "plan",
      runId,
      title: plan?.title ?? "计划"
    };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surface.id)
      ? current.map((candidate) => candidate.id === surface.id ? { ...candidate, title: surface.title } : candidate)
      : [...current, surface]);
    setActiveSurfaceId(surface.id);
  }, [session?.plans]);
  useEffect(() => {
    const plans = session?.plans ?? [];
    setSurfaces((current) => {
      let changed = false;
      const next = current.map((surface) => {
        if (surface.kind !== "plan") return surface;
        const plan = [...plans].reverse().find((candidate) => candidate.runId === surface.runId && candidate.callId === surface.callId);
        if (!plan || plan.title === surface.title) return surface;
        changed = true;
        return { ...surface, title: plan.title };
      });
      return changed ? next : current;
    });
  }, [session?.plans]);
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
  useEffect(() => {
    if (!desktop) return;
    void desktop.projects.recent()
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setProjectsReady(true));
  }, [desktop]);
  const activateDraftWorkspace = useCallback(async (next: DraftWorkspace) => {
    if (desktop && next.kind === "project") {
      setProjects(await desktop.projects.activate(next.projectRoot));
    }
    setDraftWorkspace(next);
  }, [desktop, setDraftWorkspace]);
  const createSession = useCallback(async (preferredRoot?: string) => {
    const next = preferredRoot
      ? projectDraftWorkspace(preferredRoot)
      : defaultDraftWorkspace({
        current: session,
        currentExists: workspace?.exists !== false && (!desktop || projects.some((project) => project.path === session?.projectRoot)),
        fallbackProjectRoot: desktop ? undefined : config?.workspaceRoot,
        projects: selectableProjects
      });
    try {
      await activateDraftWorkspace(next);
      newSession(next);
    } catch (nextError) {
      reportError(nextError);
    }
  }, [activateDraftWorkspace, config?.workspaceRoot, desktop, newSession, reportError, selectableProjects, session, workspace?.exists]);
  const pickProject = useCallback(async () => {
    if (!desktop) return null;
    const selected = await desktop.projects.pick();
    if (selected) setProjects(await desktop.projects.recent());
    return selected;
  }, [desktop]);
  const openSession = useCallback(async (sessionId: string) => {
    const summary = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (desktop && summary?.workspaceKind === "project" && projects.some((project) => project.path === summary.projectRoot)) {
      setProjects(await desktop.projects.activate(summary.projectRoot));
    }
    await selectSession(sessionId);
  }, [desktop, projects, selectSession, sessions]);
  useEffect(() => {
    if (session || draftWorkspace || !config || !projectsReady) return;
    const next = defaultDraftWorkspace({
      fallbackProjectRoot: desktop ? undefined : config.workspaceRoot,
      projects: selectableProjects
    });
    void activateDraftWorkspace(next).catch((nextError) => {
      reportError(nextError);
      setDraftWorkspace({ kind: "scratch" });
    });
  }, [activateDraftWorkspace, config, desktop, draftWorkspace, projectsReady, reportError, selectableProjects, session, setDraftWorkspace]);
  return (
    <AppErrorBoundary>
      <div className="app-frame">
        <AppTopbar onToggleSidebar={() => setSidebarOpen((open) => !open)} />
        <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        <SessionSidebar
          desktopProjectsManaged={Boolean(desktop)}
          onArchiveProject={(root) => archiveProjectSessions(root)}
          onArchiveSession={(sessionId) => archiveSession(sessionId)}
          onNewSession={(preferredRoot) => void createSession(preferredRoot)}
          onOpenProject={desktop ? (root) => desktop.projects.open(root) : undefined}
          onPinProject={desktop ? async (root, pinned) => setProjects(await desktop.projects.pin(root, pinned)) : undefined}
          onPinSession={(sessionId, pinned) => pinSession(sessionId, pinned)}
          onRemoveProject={desktop ? async (root) => setProjects(await desktop.projects.remove(root)) : undefined}
          onRenameProject={desktop ? async (root, name) => setProjects(await desktop.projects.rename(root, name)) : undefined}
          onSearch={searchSessions}
          onSelectSession={(sessionId) => void openSession(sessionId)}
          onSettings={window.deepseeker ? () => setSettingsOpen(true) : undefined}
          onWidthChange={setSidebarWidth}
          onWidthReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          selectedSessionKey={session?.sessionId ?? null}
          sidebarWidth={sidebarWidth}
          sessions={sessions}
          projects={projects}
        />
        <main
          className={`workspace conversation-workspace ${surfaces.length > 0 ? "has-surface" : ""}`}
          style={{ "--surface-width": `${effectiveSurfaceWidth}px` } as CSSProperties}
        >
          <div className="conversation-main">
            <header className="thread-header">
              <div className="thread-title"><Folder size={16} /><span>{session?.title ?? "DeepSeeker CodeAgent"}</span><MoreHorizontal size={14} /></div>
              <ConnectionStatus onRetry={window.deepseeker ? () => void retryRuntime() : undefined} phase={connection} />
            </header>
            <div className="window-actions"><IconButton className="icon-button" label="视图设置"><SlidersHorizontal size={14} /></IconButton><IconButton className="icon-button" label="工作区面板"><PanelRight size={14} /></IconButton></div>
            <Inspector onOpenReview={openReviewSurface} session={session} workspace={workspace} />
            <Conversation onOpenFile={openFileSurface} onOpenPlan={openPlanSurface} onOpenReview={openReviewSurface} onStopCommand={(commandId) => void stopCommand(commandId)} session={session} />
            {currentRun && (
              <div
                aria-hidden={!activeRun || Boolean(pendingPlan || pendingQuestion)}
                className={`composer-hud is-${currentRun.status} ${activeRun && !pendingPlan && !pendingQuestion ? "is-visible" : "is-collapsed"}`}
              >
                <div className="composer-hud-primary">
                  <span className={agentRunning ? "working-glow" : ""}>{waitingRun ? "等待决定" : activeRun ? "正在执行" : "最近工作"}</span>
                  <strong className={agentRunning ? "working-glow" : ""}>{workLabel}</strong>
                </div>
                <span className="composer-hud-changes">{currentDelta.fileCount} 个文件已更改 <b>+{currentDelta.additions}</b> <i>-{currentDelta.deletions}</i></span>
              </div>
            )}
            {!config?.hasApiKey && config && <div className="composer-notice">未配置 DeepSeek Key，当前使用 <strong>mock-agent</strong></div>}
            {workspace?.exists === false && <div className="composer-error">项目目录不存在，请新建任务并重新选择项目。</div>}
            {error && <div className="composer-error">{error}</div>}
            <ApprovalDialog approval={pendingApproval} onResolve={(decision) => void resolveApproval(decision)} />
            <div className={`composer-stack ${!session ? "has-project-context" : ""}`}>
              {!session && draftWorkspace && (
                <ProjectContextSelector
                  canAddProject={Boolean(desktop)}
                  onAddProject={pickProject}
                  onChange={activateDraftWorkspace}
                  projects={selectableProjects}
                  selection={draftWorkspace}
                />
              )}
              <Composer
                balance={balance}
                contextConfig={config}
                contextObserver={contextObserver}
                disabledReason={session ? workspace?.exists === false ? "项目目录不存在" : undefined : draftWorkspace ? undefined : "正在准备工作区"}
                isRunning={agentRunning}
                isWaiting={Boolean(waitingRun)}
                model={model}
                onCancel={() => void cancelRun()}
                onAccessModeChange={(mode) => void setAccessMode(mode)}
                onModeChange={(nextMode) => void setMode(nextMode)}
                onAnswerQuestion={answerQuestion}
                onResolvePlan={resolvePlan}
                onSubmit={startRun}
                pendingPlan={pendingPlan}
                pendingQuestion={pendingQuestion}
                resetKey={session?.sessionId ?? `draft:${draftRevision}`}
                accessMode={accessMode}
                mode={mode}
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
            onRevisePlan={revisePlan}
            onSelectSurface={setActiveSurfaceId}
            onWidthChange={setSurfaceWidth}
            onWidthReset={() => setSurfaceWidth(DEFAULT_SURFACE_WIDTH)}
            panelMaxWidth={() => surfaceMaxWidth}
            panelWidth={effectiveSurfaceWidth}
            surfaces={surfaces}
            plans={session?.plans ?? []}
            runs={session?.runs ?? []}
          />
        </main>
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        </div>
      </div>
    </AppErrorBoundary>
  );
}
