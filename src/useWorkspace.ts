import { useCallback, useEffect, useMemo, useState } from "react";
import { reduceEvents } from "../shared/domain/reducer";
import { ApprovalChoice, isRunDone, AccessMode, SessionSummary, Session } from "../shared/contracts/runtime";
import { ConnectionPhase } from "./components/ConnectionStatus";
import { parseEventMessage, runtimeApi, RuntimeConfig, RuntimeContextObserver, RuntimeRequestError } from "./runtimeApi";

export function useWorkspace() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<ConnectionPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draftAccessMode, setDraftAccessMode] = useState<AccessMode>("request_approval");
  const [contextObserver, setContextObserver] = useState<RuntimeContextObserver | null>(null);

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
      setDraftAccessMode(next.accessMode ?? "request_approval");
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
    const source = new EventSource(runtimeApi.streamUrl(sessionId, session.lastOffset));
    let disposed = false;
    source.onopen = () => {
      setConnection("connected");
      void runtimeApi.getSession(sessionId)
        .then(({ session: snapshot }) => {
          if (disposed) return;
          setSession((current) => {
            if (current?.sessionId !== sessionId || snapshot.lastOffset < current.lastOffset) return current;
            return snapshot;
          });
          setDraftAccessMode(snapshot.accessMode ?? "request_approval");
          const latestRun = snapshot.runs.at(-1);
          if (latestRun && isRunDone(latestRun.status)) void refreshSessions();
        })
        .catch(() => {
          if (!disposed) setConnection(navigator.onLine ? "reconnecting" : "offline");
        });
    };
    source.onmessage = (event) => {
      const events = parseEventMessage(event.data);
      if (events.length === 0) return;
      setSession((current) => current?.sessionId === sessionId ? reduceEvents(current, events) : current);
      if (events.some((item) => item.type === "run.finished")) void refreshSessions();
    };
    source.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    return () => {
      disposed = true;
      source.close();
    };
  }, [refreshSessions, session?.sessionId]);

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

  const pendingApproval = activeRun?.approvals.find((approval) => approval.state === "pending");
  const model = config?.hasApiKey ? config.defaultModel : "mock-agent";

  const startRun = useCallback(async (prompt: string) => {
    setError(null);
    try {
      const result = await runtimeApi.startRun({ model, accessMode: draftAccessMode, prompt, sessionId: session?.sessionId });
      setSession(result.session);
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [draftAccessMode, model, refreshSessions, session?.sessionId]);

  const cancelRun = useCallback(async () => {
    if (!activeRun) return;
    try {
      await runtimeApi.cancelRun(activeRun.runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [activeRun]);

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

  return {
    activeRun,
    cancelRun,
    config,
    connection,
    contextObserver,
    currentRun: session?.runs.at(-1),
    error,
    model,
    newSession: () => { setSession(null); setError(null); setDraftAccessMode("request_approval"); },
    pendingApproval,
    accessMode: draftAccessMode,
    resolveApproval,
    searchSessions: (query: string) => void refreshSessions(query),
    selectSession,
    setAccessMode,
    session,
    sessions,
    startRun
  };
}
