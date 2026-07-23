import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ApprovalChoice, isRunDone, AccessMode, Mode, Plan, PlanDecision, PlanEntry, SessionSummary, Session } from "../shared/contracts/runtime";
import { ConnectionPhase } from "./components/ConnectionStatus";
import { runtimeApi, RuntimeBalance, RuntimeConfig, RuntimeContextObserver, RuntimeRequestError, RuntimeWorkspace } from "./runtimeApi";
import { DraftWorkspace, projectDraftWorkspace } from "./workspaceSelection";
import { SessionEventStore, SessionUpdater } from "./features/runtime/sessionEventStore";

export function useWorkspace() {
  const [sessionStore] = useState(() => new SessionEventStore());
  const session = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getSnapshot
  );
  const setSession = useCallback((next: SessionUpdater) => sessionStore.update(next), [sessionStore]);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [connection, setConnection] = useState<ConnectionPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draftAccessMode, setDraftAccessMode] = useState<AccessMode>("request_approval");
  const [draftMode, setDraftMode] = useState<Mode>("work");
  const [draftPlanEntry, setDraftPlanEntry] = useState<PlanEntry>("suggest");
  const [contextObserver, setContextObserver] = useState<RuntimeContextObserver | null>(null);
  const [draftWorkspace, setDraftWorkspace] = useState<DraftWorkspace | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [workspace, setWorkspace] = useState<RuntimeWorkspace | null>(null);
  const [balance, setBalance] = useState<RuntimeBalance | null>(null);

  const refreshSessions = useCallback(async (query = "") => {
    const result = await runtimeApi.listSessions(query);
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const reportError = useCallback((nextError: unknown) => {
    setError(nextError instanceof Error ? nextError.message : String(nextError));
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    setError(null);
    try {
      const next = (await runtimeApi.getSession(sessionId)).session;
      setSession(next);
      setDraftRevision((current) => current + 1);
      setDraftAccessMode(next.accessMode ?? "request_approval");
      setDraftMode(next.mode ?? "work");
      setDraftPlanEntry(next.planEntry ?? "suggest");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const activeRun = useMemo(
    () => [...(session?.runs ?? [])].reverse().find((run) => !isRunDone(run.status)),
    [session]
  );

  useEffect(() => {
    void Promise.all([runtimeApi.config(), refreshSessions()])
      .then(([runtimeConfig, availableSessions]) => {
        setConfig(runtimeConfig);
        if (!window.deepseeker) setDraftWorkspace(projectDraftWorkspace(runtimeConfig.workspaceRoot));
        setConnection("connected");
        if (availableSessions[0]) void selectSession(availableSessions[0].sessionId);
      })
      .catch((nextError) => {
        setConnection("offline");
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
  }, [refreshSessions, selectSession]);

  useEffect(() => {
    if (!session?.sessionId) return;
    const sessionId = session.sessionId;
    let disposed = false;
    const close = runtimeApi.subscribe({
      afterOffset: session.lastOffset,
      onError: () => setConnection(navigator.onLine ? "reconnecting" : "offline"),
      onEvents: (events) => {
        sessionStore.applyEvents(sessionId, events);
        if (events.some((item) => item.type === "run.finished")) void refreshSessions();
      },
      onOpen: () => {
        setConnection("connected");
        void runtimeApi.getSession(sessionId)
          .then(({ session: snapshot }) => {
            if (disposed) return;
            sessionStore.replaceSnapshot(snapshot);
            setDraftAccessMode(snapshot.accessMode ?? "request_approval");
            setDraftMode(snapshot.mode ?? "work");
            setDraftPlanEntry(snapshot.planEntry ?? "suggest");
            const latestRun = snapshot.runs.at(-1);
            if (latestRun && isRunDone(latestRun.status)) void refreshSessions();
          })
          .catch(() => { if (!disposed) setConnection(navigator.onLine ? "reconnecting" : "offline"); });
      },
      sessionId
    });
    return () => {
      disposed = true;
      close();
    };
  }, [refreshSessions, session?.sessionId, sessionStore]);

  useEffect(() => {
    if (!session?.sessionId) {
      setWorkspace(null);
      return;
    }
    let disposed = false;
    const refresh = () => void runtimeApi.getWorkspace(session.sessionId)
      .then(({ workspace: next }) => { if (!disposed) setWorkspace(next); })
      .catch(() => { if (!disposed) setWorkspace(null); });
    refresh();
    const timer = activeRun ? window.setInterval(refresh, 3_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRun, session?.sessionId, session?.updatedAt]);

  useEffect(() => {
    if (!window.deepseeker) return;
    return window.deepseeker.runtime.onState((state) => {
      if (state.phase === "ready") setConnection("connecting");
      else if (state.phase === "failed" || state.phase === "stopped") setConnection("offline");
      else setConnection("reconnecting");
    });
  }, []);

  useEffect(() => {
    const sessionId = session?.sessionId;
    if (!sessionId) {
      setContextObserver(null);
      return;
    }
    let disposed = false;
    const refresh = () => void runtimeApi.getContextObserver(sessionId)
      .then(({ observer }) => { if (!disposed) setContextObserver(observer); })
      .catch(() => undefined);
    refresh();
    const timer = activeRun ? window.setInterval(refresh, 2_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRun, session?.sessionId, session?.updatedAt]);

  // 余额轮询:账户级数据,与 activeRun 解耦。60s 一次,仅在配置了 API key 时启动。
  // 余额查询:账户级数据,与 activeRun 解耦。
  // 不再定时轮询——改为在用户鼠标悬浮上下文图标时按需刷新(refreshBalance)。
  // 首次配置 API key 时自动获取一次,后续由 UI 悬浮事件触发。
  // 失败静默,余额是辅助信息,查询失败不打扰用户。
  const refreshBalance = useCallback(() => {
    if (!config?.hasApiKey) {
      setBalance(null);
      return;
    }
    void runtimeApi.getBalance()
      .then((result) => setBalance(result))
      .catch(() => undefined);
  }, [config?.hasApiKey]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    if (!session) return;
    setDraftMode(session.mode);
    setDraftPlanEntry(session.planEntry);
  }, [session?.mode, session?.planEntry]);

  const pendingApproval = activeRun?.approvals.find((approval) => approval.state === "pending");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const model = selectedModel || (config?.hasApiKey ? config.defaultModel : "mock-agent");

  const changeModel = useCallback((next: string) => {
    setSelectedModel(next);
  }, []);

  const startRun = useCallback(async (prompt: string): Promise<boolean> => {
    setError(null);
    if (!session && !draftWorkspace) {
      setError("请先选择工作项目或临时工作区。");
      return false;
    }
    try {
      const result = await runtimeApi.startRun({
        model,
        accessMode: draftAccessMode,
        mode: draftMode,
        planEntry: draftPlanEntry,
        projectRoot: !session && draftWorkspace?.kind === "project" ? draftWorkspace.projectRoot : undefined,
        prompt,
        sessionId: session?.sessionId,
        workspaceKind: session ? undefined : draftWorkspace?.kind
      });
      setSession(result.session);
      void refreshSessions().catch((nextError) => {
        setError(`任务已创建，但侧边栏刷新失败：${nextError instanceof Error ? nextError.message : String(nextError)}`);
      });
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    }
  }, [draftAccessMode, draftMode, draftPlanEntry, draftWorkspace, model, refreshSessions, session]);

  const newSession = useCallback((nextWorkspace: DraftWorkspace) => {
    setSession(null);
    setWorkspace(null);
    setDraftWorkspace(nextWorkspace);
    setDraftRevision((current) => current + 1);
    setError(null);
    setDraftAccessMode("request_approval");
    setDraftMode("work");
    setDraftPlanEntry(config?.planEntry ?? "suggest");
  }, [config?.planEntry]);

  const retryRuntime = useCallback(async () => {
    if (!window.deepseeker) return;
    setConnection("connecting");
    try {
      const connection = await window.deepseeker.runtime.retry();
      runtimeApi.configure(connection);
      const nextConfig = await runtimeApi.config();
      setConfig(nextConfig);
      setConnection("connected");
      await refreshSessions();
    } catch (nextError) {
      setConnection("offline");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [refreshSessions]);

  const cancelRun = useCallback(async () => {
    if (!activeRun) return;
    try {
      await runtimeApi.cancelRun(activeRun.runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [activeRun]);

  const stopCommand = useCallback(async (commandId: string) => {
    try {
      await runtimeApi.stopCommand(commandId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const pinSession = useCallback(async (sessionId: string, pinned: boolean) => {
    try {
      await runtimeApi.setSessionSidebar(sessionId, { pinned });
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [refreshSessions]);

  const archiveSession = useCallback(async (sessionId: string) => {
    try {
      await runtimeApi.setSessionSidebar(sessionId, { archived: true });
      if (session?.sessionId === sessionId) {
        setDraftWorkspace(session.workspaceKind === "scratch" ? { kind: "scratch" } : projectDraftWorkspace(session.projectRoot));
        setDraftRevision((current) => current + 1);
        setSession(null);
        setWorkspace(null);
      }
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    }
  }, [refreshSessions, session?.sessionId]);

  const archiveProjectSessions = useCallback(async (root: string) => {
    try {
      await runtimeApi.archiveProjectSessions(root);
      if (session?.projectRoot === root) {
        setDraftWorkspace(projectDraftWorkspace(root));
        setDraftRevision((current) => current + 1);
        setSession(null);
        setWorkspace(null);
      }
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    }
  }, [refreshSessions, session?.projectRoot]);

  const resolveApproval = useCallback(async (decision: ApprovalChoice) => {
    if (!pendingApproval) return;
    try {
      await runtimeApi.resolveApproval(pendingApproval.approvalId, decision);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [pendingApproval]);

  const setAccessMode = useCallback(async (accessMode: AccessMode) => {
    setDraftAccessMode(accessMode);
    if (!session) return;
    try {
      const result = await runtimeApi.setAccessMode(session.sessionId, accessMode);
      setSession(result.session);
    } catch (nextError) {
      if (nextError instanceof RuntimeRequestError && nextError.status === 404) {
        setError("当前 Runtime 进程还没有权限档位接口，重启 Runtime 后该选择会生效。");
        return;
      }
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session]);

  const setMode = useCallback(async (mode: Mode) => {
    setDraftMode(mode);
    if (!session) return;
    try {
      const result = await runtimeApi.setMode(session.sessionId, { mode });
      setSession(result.session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session]);

  const resolvePlan = useCallback(async (plan: Plan, decision: PlanDecision, comments?: string, nextAccessMode?: AccessMode) => {
    if (!session) return;
    setError(null);
    try {
      const result = await runtimeApi.resolvePlan(session.sessionId, plan, { accessMode: nextAccessMode, comments, decision });
      setSession(result.session);
      if (decision === "start_work" && nextAccessMode) setDraftAccessMode(nextAccessMode);
      if (decision === "start_work" || decision === "cancel") setDraftMode("work");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session]);

  const revisePlan = useCallback(async (plan: Plan, title: string, markdown: string) => {
    if (!session) return;
    setError(null);
    try {
      const result = await runtimeApi.revisePlan(session.sessionId, plan, { markdown, title });
      setSession(result.session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session]);

  const answerQuestion = useCallback(async (interactionId: string, answers: Record<string, string>) => {
    if (!session) return;
    setError(null);
    try {
      const result = await runtimeApi.answerQuestion(session.sessionId, interactionId, answers);
      setSession(result.session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [session]);

  return {
    activeRun,
    accessMode: draftAccessMode,
    answerQuestion,
    archiveProjectSessions,
    archiveSession,
    balance,
    cancelRun,
    changeModel,
    config,
    connection,
    contextObserver,
    currentRun: session?.runs.at(-1),
    draftRevision,
    draftWorkspace,
    error,
    model,
    mode: draftMode,
    newSession,
    pendingApproval,
    pinSession,
    planEntry: draftPlanEntry,
    projectRoot: session?.projectRoot ?? (draftWorkspace?.kind === "project" ? draftWorkspace.projectRoot : null),
    reportError,
    resolveApproval,
    resolvePlan,
    revisePlan,
    refreshBalance,
    retryRuntime,
    searchSessions: (query: string) => void refreshSessions(query),
    selectSession,
    setAccessMode,
    setDraftWorkspace,
    setMode,
    session,
    sessions,
    startRun,
    stopCommand,
    workspace
  };
}
