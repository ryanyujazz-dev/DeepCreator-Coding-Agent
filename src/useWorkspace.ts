import { useCallback, useEffect, useMemo, useState } from "react";
import { reduceEvents } from "../shared/domain/reducer";
import { ApprovalChoice, isRunDone, AccessMode, Mode, Plan, PlanDecision, PlanEntry, SessionSummary, Session } from "../shared/contracts/runtime";
import { ConnectionPhase } from "./components/ConnectionStatus";
import { runtimeApi, RuntimeConfig, RuntimeContextObserver, RuntimeRequestError, RuntimeWorkspace } from "./runtimeApi";

export function useWorkspace() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<ConnectionPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draftAccessMode, setDraftAccessMode] = useState<AccessMode>("request_approval");
  const [draftMode, setDraftMode] = useState<Mode>("work");
  const [draftPlanEntry, setDraftPlanEntry] = useState<PlanEntry>("suggest");
  const [contextObserver, setContextObserver] = useState<RuntimeContextObserver | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<RuntimeWorkspace | null>(null);

  const refreshSessions = useCallback(async (query = "") => {
    const result = await runtimeApi.listSessions(query);
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    setError(null);
    try {
      const next = (await runtimeApi.getSession(sessionId)).session;
      setSession(next);
      setProjectRoot(next.projectRoot);
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
        if (!window.deepseeker) setProjectRoot(runtimeConfig.workspaceRoot);
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
        setSession((current) => current?.sessionId === sessionId ? reduceEvents(current, events) : current);
        if (events.some((item) => item.type === "run.finished")) void refreshSessions();
      },
      onOpen: () => {
        setConnection("connected");
        void runtimeApi.getSession(sessionId)
          .then(({ session: snapshot }) => {
            if (disposed) return;
            setSession((current) => {
              if (current?.sessionId !== sessionId || snapshot.lastOffset < current.lastOffset) return current;
              return snapshot;
            });
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
  }, [refreshSessions, session?.sessionId]);

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

  useEffect(() => {
    if (!session) return;
    setDraftMode(session.mode);
    setDraftPlanEntry(session.planEntry);
  }, [session?.mode, session?.planEntry]);

  const pendingApproval = activeRun?.approvals.find((approval) => approval.state === "pending");
  const model = config?.hasApiKey ? config.defaultModel : "mock-agent";

  const startRun = useCallback(async (prompt: string) => {
    setError(null);
    if (!session && !projectRoot) {
      setError("请先选择一个项目文件夹。");
      return;
    }
    try {
      const result = await runtimeApi.startRun({
        model,
        accessMode: draftAccessMode,
        mode: draftMode,
        planEntry: draftPlanEntry,
        projectRoot: session ? undefined : projectRoot ?? undefined,
        prompt,
        sessionId: session?.sessionId
      });
      setSession(result.session);
      setProjectRoot(result.session.projectRoot);
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [draftAccessMode, draftMode, draftPlanEntry, model, projectRoot, refreshSessions, session]);

  const newSession = useCallback(async (preferredRoot?: string) => {
    let nextRoot = preferredRoot;
    if (!nextRoot && window.deepseeker) {
      const selected = await window.deepseeker.projects.pick();
      if (!selected) return;
      nextRoot = selected.path;
    }
    setSession(null);
    setWorkspace(null);
    setProjectRoot(nextRoot ?? config?.workspaceRoot ?? null);
    setError(null);
    setDraftAccessMode("request_approval");
    setDraftMode("work");
    setDraftPlanEntry(config?.planEntry ?? "suggest");
  }, [config]);

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
    cancelRun,
    config,
    connection,
    contextObserver,
    currentRun: session?.runs.at(-1),
    error,
    model,
    mode: draftMode,
    newSession,
    pendingApproval,
    pinSession,
    planEntry: draftPlanEntry,
    projectRoot,
    resolveApproval,
    resolvePlan,
    revisePlan,
    retryRuntime,
    searchSessions: (query: string) => void refreshSessions(query),
    selectSession,
    setAccessMode,
    setMode,
    session,
    sessions,
    startRun,
    stopCommand,
    workspace
  };
}
