import { useCallback, useEffect, useMemo, useState } from "react";
import { reduceSignals } from "../shared/signalReducer";
import { ApprovalDecision, isTerminalCycle, PermissionProfileKey, SessionListEntry, WorkspaceSessionView } from "../shared/runtimeTypes";
import { ConnectionPhase } from "./components/ConnectionStatus";
import { parseSignalMessage, runtimeClient, RuntimeConfig, RuntimeContextObserver, RuntimeRequestError } from "./runtimeClient";

export function useRuntimeWorkspace() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [session, setSession] = useState<WorkspaceSessionView | null>(null);
  const [connection, setConnection] = useState<ConnectionPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draftPermissionProfile, setDraftPermissionProfile] = useState<PermissionProfileKey>("request_approval");
  const [contextObserver, setContextObserver] = useState<RuntimeContextObserver | null>(null);

  const refreshSessions = useCallback(async (query = "") => {
    const result = await runtimeClient.listSessions(query);
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const selectSession = useCallback(async (sessionKey: string) => {
    setError(null);
    try {
      const next = (await runtimeClient.getSession(sessionKey)).session;
      setSession(next);
      setDraftPermissionProfile(next.permissionProfile ?? "request_approval");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const activeCycle = useMemo(
    () => [...(session?.cycles ?? [])].reverse().find((cycle) => !isTerminalCycle(cycle.phase)),
    [session]
  );

  useEffect(() => {
    void Promise.all([runtimeClient.config(), refreshSessions()])
      .then(([runtimeConfig, availableSessions]) => {
        setConfig(runtimeConfig);
        setConnection("connected");
        if (availableSessions[0]) void selectSession(availableSessions[0].sessionKey);
      })
      .catch((nextError) => {
        setConnection("offline");
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
  }, [refreshSessions, selectSession]);

  useEffect(() => {
    if (!session?.sessionKey) return;
    const sessionKey = session.sessionKey;
    const source = new EventSource(runtimeClient.streamUrl(sessionKey, session.lastOffset));
    let disposed = false;
    source.onopen = () => {
      setConnection("connected");
      void runtimeClient.getSession(sessionKey)
        .then(({ session: snapshot }) => {
          if (disposed) return;
          setSession((current) => {
            if (current?.sessionKey !== sessionKey || snapshot.lastOffset < current.lastOffset) return current;
            return snapshot;
          });
          setDraftPermissionProfile(snapshot.permissionProfile ?? "request_approval");
          const latestCycle = snapshot.cycles.at(-1);
          if (latestCycle && isTerminalCycle(latestCycle.phase)) void refreshSessions();
        })
        .catch(() => {
          if (!disposed) setConnection(navigator.onLine ? "reconnecting" : "offline");
        });
    };
    source.onmessage = (event) => {
      const signals = parseSignalMessage(event.data);
      if (signals.length === 0) return;
      setSession((current) => current?.sessionKey === sessionKey ? reduceSignals(current, signals) : current);
      if (signals.some((signal) => signal.topic === "cycle.settled")) void refreshSessions();
    };
    source.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    return () => {
      disposed = true;
      source.close();
    };
  }, [refreshSessions, session?.sessionKey]);

  useEffect(() => {
    const sessionKey = session?.sessionKey;
    if (!sessionKey) {
      setContextObserver(null);
      return;
    }
    let disposed = false;
    const refresh = () => void runtimeClient.getContextObserver(sessionKey)
      .then(({ observer }) => { if (!disposed) setContextObserver(observer); })
      .catch(() => undefined);
    refresh();
    const timer = activeCycle ? window.setInterval(refresh, 2_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeCycle, session?.sessionKey, session?.updatedAt]);

  const pendingApproval = activeCycle?.approvals.find((approval) => approval.state === "pending");
  const model = config?.hasApiKey ? config.defaultModel : "mock-agent";

  const startCycle = useCallback(async (prompt: string) => {
    setError(null);
    try {
      const result = await runtimeClient.startCycle({ model, permissionProfile: draftPermissionProfile, prompt, sessionKey: session?.sessionKey });
      setSession(result.session);
      await refreshSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [draftPermissionProfile, model, refreshSessions, session?.sessionKey]);

  const cancelCycle = useCallback(async () => {
    if (!activeCycle) return;
    try {
      await runtimeClient.cancelCycle(activeCycle.cycleKey);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [activeCycle]);

  const resolveApproval = useCallback(async (decision: ApprovalDecision) => {
    if (!pendingApproval) return;
    try {
      await runtimeClient.resolveApproval(pendingApproval.approvalKey, decision);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [pendingApproval]);

  const setPermissionProfile = useCallback(async (permissionProfile: PermissionProfileKey) => {
    setDraftPermissionProfile(permissionProfile);
    if (!session) return;
    try {
      const result = await runtimeClient.setPermissionProfile(session.sessionKey, permissionProfile);
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
    activeCycle,
    cancelCycle,
    config,
    connection,
    contextObserver,
    currentCycle: session?.cycles.at(-1),
    error,
    model,
    newSession: () => { setSession(null); setError(null); setDraftPermissionProfile("request_approval"); },
    pendingApproval,
    permissionProfile: draftPermissionProfile,
    resolveApproval,
    searchSessions: (query: string) => void refreshSessions(query),
    selectSession,
    setPermissionProfile,
    session,
    sessions,
    startCycle
  };
}
