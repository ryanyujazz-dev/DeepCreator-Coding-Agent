import { Component, ReactNode, useCallback, useState } from "react";
import { MoreHorizontal, PanelRight, SlidersHorizontal, TerminalSquare } from "lucide-react";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { Composer } from "./components/Composer";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ConversationViewport } from "./components/ConversationViewport";
import { SessionSidebar } from "./components/SessionSidebar";
import { WorkspaceInspector } from "./components/WorkspaceInspector";
import { WorkspaceSurface, WorkspaceSurfacePanel } from "./components/WorkspaceSurfacePanel";
import { RuntimeFilePreview, runtimeClient } from "./runtimeClient";
import { useRuntimeWorkspace } from "./useRuntimeWorkspace";
import { FileDeltaView } from "../shared/runtimeTypes";

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
  const [surface, setSurface] = useState<WorkspaceSurface | null>(null);
  const [surfaceFile, setSurfaceFile] = useState<RuntimeFilePreview | null>(null);
  const [surfaceFileError, setSurfaceFileError] = useState<string | null>(null);
  const [surfaceFileLoading, setSurfaceFileLoading] = useState(false);
  const [surfaceClosing, setSurfaceClosing] = useState(false);
  const {
    activeCycle,
    cancelCycle,
    config,
    connection,
    currentCycle,
    error,
    model,
    newSession,
    pendingApproval,
    permissionProfile,
    resolveApproval,
    searchSessions,
    selectSession,
    setPermissionProfile,
    session,
    sessions,
    startCycle
  } = useRuntimeWorkspace();
  const activeStep = currentCycle?.plan.find((step) => step.state === "in_progress");
  const workLabel = activeCycle
    ? activeStep?.label ?? "Agent 正在处理"
    : currentCycle?.phase === "failed"
      ? "工作已中断"
      : currentCycle?.phase === "cancelled"
        ? "工作已取消"
        : "工作已结束";
  const currentDelta = currentCycle?.workspaceDelta.comparisonBase === "cycle_start"
    ? currentCycle.workspaceDelta
    : { additions: 0, deletions: 0, fileCount: 0 };
  const openFileSurface = useCallback((filePath: string, fileDelta?: FileDeltaView) => {
    if (!session?.sessionKey) return;
    const cycleDeltas = session.cycles
      .map((cycle) => cycle.workspaceDelta)
      .filter((delta) => delta.comparisonBase === "cycle_start" && delta.fileCount > 0);
    const latestDelta = [...cycleDeltas].reverse().find((delta) => delta.files.some((file) => file.path === filePath));
    const matchedFile = fileDelta ?? latestDelta?.files.find((file) => file.path === filePath);
    setSurfaceClosing(false);
    setSurface({ changedFiles: latestDelta?.files, file: matchedFile, kind: "file", path: filePath });
    setSurfaceFile(null);
    setSurfaceFileError(null);
    setSurfaceFileLoading(true);
    void runtimeClient.getFile(session.sessionKey, filePath)
      .then((file) => {
        setSurfaceFile(file);
        setSurfaceFileError(null);
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSurfaceFileError(/Route GET:\/api\/sessions\/.+\/files|not found/i.test(message)
          ? "文件读取接口未生效，请重启 Runtime。"
          : message);
      })
      .finally(() => setSurfaceFileLoading(false));
  }, [session]);
  const closeSurface = useCallback(() => {
    setSurfaceClosing(true);
    window.setTimeout(() => {
      setSurface(null);
      setSurfaceFile(null);
      setSurfaceFileError(null);
      setSurfaceClosing(false);
    }, 190);
  }, []);

  return (
    <AppErrorBoundary>
      <div className="app-shell">
        <SessionSidebar
          onNewSession={newSession}
          onSearch={searchSessions}
          onSelectSession={(sessionKey) => void selectSession(sessionKey)}
          selectedSessionKey={session?.sessionKey ?? null}
          sessions={sessions}
        />
        <main className={`workspace conversation-workspace ${surface ? "has-surface" : ""}`}>
          <div className="conversation-main">
            <header className="thread-header">
              <div className="thread-title"><TerminalSquare size={16} /><span>{session?.title ?? "DeepSeeker CodeAgent"}</span><MoreHorizontal size={14} /></div>
              <ConnectionStatus phase={connection} />
            </header>
            <div className="window-actions"><button className="icon-button" aria-label="视图设置"><SlidersHorizontal size={14} /></button><button className="icon-button" aria-label="工作区面板"><PanelRight size={14} /></button></div>
            <WorkspaceInspector session={session} />
            <ConversationViewport onOpenFile={openFileSurface} session={session} />
            <div className="composer-dock">
              {currentCycle && (
                <div className={`composer-hud is-${currentCycle.phase}`}>
                  <span>{activeCycle ? "正在执行" : "最近工作"}</span>
                  <strong>{workLabel}</strong>
                  <span>{currentDelta.fileCount} 个文件已更改 <b>+{currentDelta.additions}</b> <i>-{currentDelta.deletions}</i></span>
                </div>
              )}
              {!config?.hasApiKey && config && <div className="composer-notice">未配置 DeepSeek Key，当前使用 <strong>mock-agent</strong></div>}
              {error && <div className="composer-error">{error}</div>}
              <ApprovalDialog approval={pendingApproval} onResolve={(decision) => void resolveApproval(decision)} />
              <Composer
                isRunning={Boolean(activeCycle)}
                model={model}
                onCancel={() => void cancelCycle()}
                onPermissionProfileChange={(profile) => void setPermissionProfile(profile)}
                onSubmit={(prompt) => void startCycle(prompt)}
                permissionProfile={permissionProfile}
              />
            </div>
          </div>
          <WorkspaceSurfacePanel
            file={surfaceFile}
            fileError={surfaceFileError}
            fileLoading={surfaceFileLoading}
            isClosing={surfaceClosing}
            onClose={closeSurface}
            surface={surface}
          />
        </main>
      </div>
    </AppErrorBoundary>
  );
}
