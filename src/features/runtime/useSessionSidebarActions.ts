import { useCallback } from "react";
import { Session, SessionSummary } from "../../../shared/contracts/runtime";
import { runtimeApi } from "../../runtimeApi";
import { SessionUpdater } from "./sessionEventStore";

type SessionSidebarActionsInput = {
  clearCurrentSession: (session: Session) => void;
  refreshSessions: (query?: string) => Promise<SessionSummary[]>;
  session: Session | null;
  setError: (message: string | null) => void;
  setSession: (next: SessionUpdater) => void;
};

export function useSessionSidebarActions({
  clearCurrentSession,
  refreshSessions,
  session,
  setError,
  setSession
}: SessionSidebarActionsInput) {
  const pinSession = useCallback(async (sessionId: string, pinned: boolean) => {
    try {
      await runtimeApi.setSessionSidebar(sessionId, { pinned });
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [refreshSessions, setError]);

  const archiveSession = useCallback(async (sessionId: string) => {
    try {
      await runtimeApi.setSessionSidebar(sessionId, { archived: true });
      if (session?.sessionId === sessionId) clearCurrentSession(session);
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [clearCurrentSession, refreshSessions, session, setError]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    try {
      const result = await runtimeApi.renameSession(sessionId, title);
      if (session?.sessionId === sessionId) setSession(result.session);
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [refreshSessions, session?.sessionId, setError, setSession]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await runtimeApi.deleteSession(sessionId);
      if (session?.sessionId === sessionId) clearCurrentSession(session);
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [clearCurrentSession, refreshSessions, session, setError]);

  const archiveProjectSessions = useCallback(async (projectRoot: string) => {
    try {
      await runtimeApi.archiveProjectSessions(projectRoot);
      if (session?.projectRoot === projectRoot) clearCurrentSession(session);
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [clearCurrentSession, refreshSessions, session, setError]);

  return { archiveProjectSessions, archiveSession, deleteSession, pinSession, renameSession };
}
