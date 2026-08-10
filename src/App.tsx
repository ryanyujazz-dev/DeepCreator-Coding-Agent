import { Component, CSSProperties, lazy, ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, LayoutPanelTop, PanelLeft, PanelRight } from "lucide-react";
import { AppTopbar } from "./components/AppTopbar";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { Composer } from "./components/Composer";
import { ProjectContextSelector } from "./components/ProjectContextSelector";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { Conversation } from "./components/Conversation";
import { SessionSidebar } from "./components/SessionSidebar";
import { Inspector } from "./components/Inspector";
import { SettingsDialog } from "./components/SettingsDialog";
import { useWorkspace } from "./useWorkspace";
import { ProjectRef } from "../shared/contracts/desktop";
import { IconButton } from "./shared-ui/ControlPrimitives";
import { defaultDraftWorkspace, DraftWorkspace, projectDraftWorkspace } from "./workspaceSelection";
import { resolveCompactSidebar, useInspectorLayout } from "./inspectorLayout";
import { browserPlatform } from "./platform/browser";
import { desktopBridge } from "./platform/desktop";
import { useSurfaceWorkspace } from "./features/surfaces/useSurfaceWorkspace";
import { AuthState } from "../shared/contracts/auth";
import { AccessMode, FollowUp, Mode } from "../shared/contracts/runtime";
import { ModelOption } from "../shared/contracts/provider";
import { useStableCallback, useStableCallbacks } from "./shared-ui/useStableCallback";

const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_SURFACE_WIDTH = 640;
const DEVELOPER_VIEW_STORAGE_KEY = "deepcreator.developerView";
// 稳定空数组:session/config 为 null 时 `?? []` 每帧新建数组会击穿 memo'd Composer 的浅比较。
const EMPTY_FOLLOW_UPS: FollowUp[] = [];
const EMPTY_MODELS: ModelOption[] = [];
type WorkspaceView = "conversation" | "settings" | "evals";
const SurfacePane = lazy(() => import("./components/SurfacePane").then((module) => ({ default: module.SurfacePane })));
const DeveloperSettingsWorkspace = import.meta.env.DEV
  ? lazy(() => import("./components/settings/SettingsWorkspace").then((module) => ({ default: module.SettingsWorkspace })))
  : null;
const DeveloperEvalWorkspace = import.meta.env.DEV
  ? lazy(() => import("./components/evals/EvalWorkspace").then((module) => ({ default: module.EvalWorkspace })))
  : null;

function storedPanelWidth(key: string, fallback: number): number {
  const stored = Number(browserPlatform.storage.get(key));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

function initialWorkspaceView(): WorkspaceView {
  return import.meta.env.DEV && browserPlatform.storage.get(DEVELOPER_VIEW_STORAGE_KEY) === "evals"
    ? "evals"
    : "conversation";
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (!this.state.message) return this.props.children;
    return <main className="workspace app-error-state"><h1>界面渲染遇到问题</h1><p>{this.state.message}</p><button onClick={browserPlatform.reload} type="button">重新加载</button></main>;
  }
}

export function App({ authState }: { authState?: AuthState }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(DEFAULT_SIDEBAR_WIDTH, storedPanelWidth("deepcreator.sidebarWidth", DEFAULT_SIDEBAR_WIDTH)));
  const [compactSidebar, setCompactSidebar] = useState(() => resolveCompactSidebar(browserPlatform.viewportWidth(), DEFAULT_SIDEBAR_WIDTH));
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  // 两段式开合动画:Phase 1(0–180ms)侧边栏叠层滑动、网格冻结;Phase 2(180–360ms)翻转 sidebarOpen,
  // 让 .app-shell 既有的 grid-template-columns 过渡驱动对话列平滑扩张/收缩。null = 静止。
  const [sidebarAnim, setSidebarAnim] = useState<null | "closing" | "opening">(null);
  const [surfaceWidth, setSurfaceWidth] = useState(() => storedPanelWidth("deepcreator.surfaceWidth", DEFAULT_SURFACE_WIDTH));
  const [surfacePanelOpen, setSurfacePanelOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(browserPlatform.viewportWidth);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [projectsReady, setProjectsReady] = useState(!desktopBridge());
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialWorkspaceView);
  const [modelNotices, setModelNotices] = useState<string[]>([]);
  const { layout: inspectorLayout, targetRef: conversationMainRef } = useInspectorLayout();
  const desktop = desktopBridge();
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
    changeModel,
    checkoutBranch,
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
    refreshBalance,
    removeFollowUp,
    answerQuestion,
    searchSessions,
    selectSession,
    setAccessMode,
    setDraftWorkspace,
    setMode,
    session,
    sessions,
    startRun,
    steerFollowUp,
    stopCommand,
    retryRuntime,
    workspace
  } = useWorkspace();
  const handleModelChange = useCallback((nextModel: string) => {
    const prevLabel = (config?.models ?? []).find((item) => item.id === model)?.label ?? model;
    const nextLabel = (config?.models ?? []).find((item) => item.id === nextModel)?.label ?? nextModel;
    changeModel(nextModel);
    setModelNotices((prev) => [...prev, `已从 ${prevLabel} 切换至 ${nextLabel}`]);
  }, [changeModel, config?.models, model]);
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
  const {
    activeFileState,
    activeSurface,
    closeActiveSurface,
    closeSurfaceTab,
    openAgentSurface,
    openFileSurface,
    openPlanSurface,
    openReviewSurface,
    setActiveSurfaceId,
    surfaceClosing,
    surfaces,
    updateReviewSurface
  } = useSurfaceWorkspace(session);
  const previousSurfaceCount = useRef(surfaces.length);
  useEffect(() => {
    if (surfaces.length > previousSurfaceCount.current) setSurfacePanelOpen(true);
    else if (surfaces.length === 0) setSurfacePanelOpen(false);
    previousSurfaceCount.current = surfaces.length;
  }, [surfaces.length]);
  const handleSurfaceClose = useCallback(() => {
    if (surfaces.length <= 1) setSurfacePanelOpen(false);
    closeActiveSurface();
  }, [closeActiveSurface, surfaces.length]);
  const compactWorkspace = viewportWidth <= 760;
  const visibleSidebarWidth = compactSidebar || !sidebarOpen ? 0 : sidebarWidth;
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
  useEffect(() => browserPlatform.storage.set("deepcreator.sidebarWidth", String(Math.round(sidebarWidth))), [sidebarWidth]);
  useEffect(() => browserPlatform.storage.set("deepcreator.surfaceWidth", String(Math.round(surfaceWidth))), [surfaceWidth]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    browserPlatform.storage.set(DEVELOPER_VIEW_STORAGE_KEY, workspaceView === "evals" ? "evals" : "conversation");
  }, [workspaceView]);
  useEffect(() => {
    const handleResize = () => setViewportWidth(browserPlatform.viewportWidth());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  useEffect(() => {
    setCompactSidebar((previous) => resolveCompactSidebar(viewportWidth, sidebarWidth, previous));
  }, [sidebarWidth, viewportWidth]);
  useEffect(() => {
    if (!compactSidebar) setSidebarOverlayOpen(false);
  }, [compactSidebar]);
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
  }, [activateDraftWorkspace, config?.workspaceRoot, desktop, newSession, projects, reportError, selectableProjects, session, workspace?.exists]);
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
  const toggleSidebar = () => {
    if (compactSidebar) {
      setSidebarOverlayOpen((open) => !open);
      return;
    }
    // 动画进行中忽略重复点击,避免方向抖动;只设方向,sidebarOpen 由时序 effect 在 180ms 后翻转。
    if (sidebarAnim) return;
    setSidebarAnim(sidebarOpen ? "closing" : "opening");
  };
  const sidebarHidden = workspaceView === "conversation" && (compactSidebar ? !sidebarOverlayOpen : !sidebarOpen);
  // 两段式时序:180ms 时翻转 sidebarOpen(触发 Phase 2 对话列网格过渡);360ms 时清掉动画态,
  // 侧边栏从叠层落回收起静止态(或展开后的常规流)。卸载/重置时清两个定时器。
  useEffect(() => {
    if (!sidebarAnim) return;
    const flipGrid = window.setTimeout(() => {
      setSidebarOpen(sidebarAnim === "closing" ? false : true);
    }, 180);
    const clearAnim = window.setTimeout(() => {
      setSidebarAnim(null);
    }, 360);
    return () => {
      window.clearTimeout(flipGrid);
      window.clearTimeout(clearAnim);
    };
  }, [sidebarAnim]);
  // === Phase 3:稳定所有传给 memo'd SessionSidebar / Composer 的 handler ===
  // 内容流式期间 session 每帧换引用 → 凡捕获 session 的回调(answerQuestion/resolvePlan/startRun/…)、
  // useWorkspace return 里的内联箭头(searchSessions)或 App 内普通 const(toggleSidebar)都每帧是新引用,
  // 令 memo 浅比较必败。useStableCallbacks 返回稳定容器、转发器调最新闭包(ref.current)→ 既稳定又不 stale。
  // 4 个 desktop 条件回调无法用对象形式(恒为函数,无法表达 undefined)→ 单回调 + prop 位保留三元
  // (desktop 稳定 → `desktop ? stableFn : undefined` 整体稳定,memo 命中)。
  const sidebarHandlers = useStableCallbacks({
    onArchiveProject: (root: string) => archiveProjectSessions(root),
    onArchiveSession: (sessionId: string) => archiveSession(sessionId),
    onNewSession: (preferredRoot?: string) => void createSession(preferredRoot),
    onPinSession: (sessionId: string, pinned: boolean) => pinSession(sessionId, pinned),
    onSearch: searchSessions,
    onSelectSession: (sessionId: string) => void openSession(sessionId),
    onToggleSidebar: toggleSidebar,
    onSettings: () => {
      if (DeveloperSettingsWorkspace) setWorkspaceView("settings");
      else setQuickSettingsOpen(true);
    },
    onWidthReset: () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
  });
  const composerHandlers = useStableCallbacks({
    onCancel: () => void cancelRun(),
    onCheckoutBranch: checkoutBranch,
    onAccessModeChange: (nextMode: AccessMode) => void setAccessMode(nextMode),
    onModeChange: (nextMode: Mode) => void setMode(nextMode),
    onAnswerQuestion: answerQuestion,
    onModelChange: handleModelChange,
    onRefreshBalance: refreshBalance,
    onRemoveFollowUp: (followUpId: string) => void removeFollowUp(followUpId),
    onResolvePlan: resolvePlan,
    onSubmit: startRun,
    onSteerFollowUp: (followUpId: string) => void steerFollowUp(followUpId)
  });
  const onOpenProject = useStableCallback((root: string) => {
    if (!desktop) return;
    // 返回 promise(而非 void 丢弃):SessionSidebar 的 runAction 会 await 它并把拒绝冒泡到
    // .sidebar-action-error toast。丢弃会让菜单直接关闭、错误只进 devtools 控制台。
    return desktop.projects.open(root);
  });
  const onPinProject = useStableCallback(async (root: string, pinned: boolean) => {
    if (!desktop) return;
    setProjects(await desktop.projects.pin(root, pinned));
  });
  const onRemoveProject = useStableCallback(async (root: string) => {
    if (!desktop) return;
    setProjects(await desktop.projects.remove(root));
  });
  const onRenameProject = useStableCallback(async (root: string, name: string) => {
    if (!desktop) return;
    setProjects(await desktop.projects.rename(root, name));
  });
  // openReviewSurface 的 deps 含 session?.runs(每帧换引用)→ 稳定包裹消除一层 churn,
  // 为 Inspector/Conversation 下游 memo 路径铺垫;转发器调最新闭包,无 staleness。
  const stableOpenReview = useStableCallback(openReviewSurface);
  return (
    <AppErrorBoundary>
      <div className="app-frame">
        <AppTopbar />
        <div
          className={`app-shell${compactSidebar ? " sidebar-auto-collapsed" : sidebarOpen ? "" : " sidebar-collapsed"}${sidebarOverlayOpen ? " sidebar-overlay-open" : ""}${sidebarAnim && !compactSidebar ? ` sidebar-animating${sidebarAnim === "closing" ? " sidebar-closing" : " sidebar-opening"}` : ""}`}
          hidden={workspaceView !== "conversation"}
          style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        >
        <SessionSidebar
          authState={authState}
          desktopProjectsManaged={Boolean(desktop)}
          {...sidebarHandlers}
          onOpenProject={desktop ? onOpenProject : undefined}
          onPinProject={desktop ? onPinProject : undefined}
          onRemoveProject={desktop ? onRemoveProject : undefined}
          onRenameProject={desktop ? onRenameProject : undefined}
          onWidthChange={setSidebarWidth}
          selectedSessionKey={session?.sessionId ?? null}
          sidebarWidth={sidebarWidth}
          sessions={sessions}
          projects={projects}
        />
        {compactSidebar && sidebarOverlayOpen && (
          <button
            aria-label="关闭侧边栏"
            className="sidebar-overlay-scrim"
            onClick={() => setSidebarOverlayOpen(false)}
            type="button"
          />
        )}
        <main
          className={`workspace conversation-workspace ${surfacePanelOpen ? "has-surface" : ""}`}
          style={{ "--surface-width": `${effectiveSurfaceWidth}px` } as CSSProperties}
        >
          <div className={`conversation-main ${inspectorVisible ? `inspector-layout-${inspectorLayout}` : ""}`} ref={conversationMainRef}>
            <header className="thread-header">
              <div className="thread-title-group">
                {sidebarHidden && <IconButton className="icon-button" label="展开侧边栏" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton>}
                <div className="thread-title"><Folder size={16} /><span>{session?.title ?? "DeepCreator CodeAgent"}</span></div>
              </div>
              <ConnectionStatus onRetry={desktop ? () => void retryRuntime() : undefined} phase={connection} />
            </header>
            <div className="window-actions"><IconButton className={inspectorVisible ? "is-active" : undefined} label={inspectorVisible ? "收起面板" : "展开面板"} onClick={() => setInspectorVisible((visible) => !visible)}><LayoutPanelTop size={16} /></IconButton><IconButton className={surfacePanelOpen ? "is-active" : undefined} label={surfacePanelOpen ? "收起工作区面板" : "展开工作区面板"} onClick={() => setSurfacePanelOpen((open) => !open)}><PanelRight size={16} /></IconButton></div>
            {inspectorVisible && (
              <Inspector
                compact={inspectorLayout === "compact"}
                connection={connection}
                onOpenFile={openFileSurface}
                onOpenPlan={openPlanSurface}
                onOpenReview={stableOpenReview}
                session={session}
                taskActive={agentRunning}
                taskLabel={workLabel}
              />
            )}
            <Conversation notices={modelNotices} onOpenAgent={openAgentSurface} onOpenFile={openFileSurface} onOpenPlan={openPlanSurface} onOpenReview={stableOpenReview} onStopCommand={(commandId) => void stopCommand(commandId)} session={session} />
            {(workspace?.exists === false || error) && (
              <div className="conversation-error-overlay">
                {workspace?.exists === false && <div className="conversation-error-toast" role="alert">项目目录不存在，请新建任务并重新选择项目。</div>}
                {error && <div className="conversation-error-toast" role="alert">{error}</div>}
              </div>
            )}
            <ApprovalDialog approval={pendingApproval} onResolve={(decision) => void resolveApproval(decision)} />
            <div className={`composer-stack ${!session ? "has-project-context" : ""}`}>
              {!config?.hasApiKey && config && <div className="composer-notice">未配置 DeepSeek Key，当前使用 <strong>mock-agent</strong></div>}
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
                followUps={session?.followUps ?? EMPTY_FOLLOW_UPS}
                model={model}
                models={config?.models ?? EMPTY_MODELS}
                {...composerHandlers}
                pendingPlan={pendingPlan}
                pendingQuestion={pendingQuestion}
                resetKey={session?.sessionId ?? `draft:${draftRevision}`}
                workspace={workspace}
                accessMode={accessMode}
                mode={mode}
              />
            </div>
          </div>
          {surfacePanelOpen && (
            <Suspense fallback={<aside className="workspace-surface-panel surface-state is-loading">正在加载工作区面板...</aside>}>
              <SurfacePane
                activeSurfaceId={activeSurface?.id ?? null}
                file={activeFileState?.file ?? null}
                fileError={activeFileState?.error ?? null}
                fileLoading={activeFileState?.loading ?? false}
                isClosing={surfaceClosing}
                onClose={handleSurfaceClose}
                onCloseSurface={closeSurfaceTab}
                onOpenFile={openFileSurface}
                onOpenReview={openReviewSurface}
                onUpdateReview={updateReviewSurface}
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
            </Suspense>
          )}
        </main>
        </div>
        {DeveloperSettingsWorkspace && (
          <div
            className="app-shell settings-shell"
            hidden={workspaceView !== "settings"}
            style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
          >
            <Suspense fallback={<main className="workspace"><div className="surface-state">正在加载设置...</div></main>}>
              <DeveloperSettingsWorkspace
                authState={authState}
                currentProjectRoot={session?.projectRoot}
                currentWorkspaceKind={session?.workspaceKind}
                onClose={() => setWorkspaceView("conversation")}
                onOpenEvals={() => setWorkspaceView("evals")}
                onWidthChange={setSidebarWidth}
                onWidthReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                showEvals={Boolean(DeveloperEvalWorkspace && config?.evalsEnabled)}
                sidebarWidth={sidebarWidth}
                visible={workspaceView === "settings"}
              />
            </Suspense>
          </div>
        )}
        {DeveloperEvalWorkspace && config?.evalsEnabled && (
          <div
            className={`app-shell eval-shell${compactSidebar ? " sidebar-auto-collapsed" : sidebarOpen ? "" : " sidebar-collapsed"}`}
            hidden={workspaceView !== "evals"}
            style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
          >
            <Suspense fallback={<main className="workspace"><div className="surface-state">正在加载评测中心...</div></main>}>
              <DeveloperEvalWorkspace
                config={config}
                connection={connection}
                onBack={() => setWorkspaceView("settings")}
                onWidthChange={setSidebarWidth}
                onWidthReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                sidebarWidth={sidebarWidth}
                viewportWidth={viewportWidth}
              />
            </Suspense>
          </div>
        )}
        {!DeveloperSettingsWorkspace && quickSettingsOpen && (
          <SettingsDialog authState={authState} onClose={() => setQuickSettingsOpen(false)} />
        )}
      </div>
    </AppErrorBoundary>
  );
}
