import { useCallback } from "react";
import { AccessMode, Mode, PlanEntry, Run, Session } from "../../../shared/contracts/runtime";
import { runtimeApi } from "../../runtimeApi";

export function useFollowUps(input: {
  accessMode: AccessMode;
  activeRun?: Run;
  mode: Mode;
  model: string;
  planEntry: PlanEntry;
  reportError: (error: unknown) => void;
  session: Session | null;
  setSession: (session: Session) => void;
}) {
  const { accessMode, activeRun, mode, model, planEntry, reportError, session, setSession } = input;
  const queueIfActive = useCallback(async (prompt: string): Promise<boolean | undefined> => {
    if (!session || !activeRun) return undefined;
    try {
      const result = await runtimeApi.queueFollowUp(session.sessionId, {
        accessMode,
        mode,
        model,
        planEntry,
        prompt
      });
      setSession(result.session);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }, [accessMode, activeRun, mode, model, planEntry, reportError, session, setSession]);

  const removeFollowUp = useCallback(async (followUpId: string) => {
    if (!session) return;
    try {
      const result = await runtimeApi.removeFollowUp(session.sessionId, followUpId);
      setSession(result.session);
    } catch (error) {
      reportError(error);
    }
  }, [reportError, session, setSession]);

  const steerFollowUp = useCallback(async (followUpId: string) => {
    if (!session) return;
    try {
      const result = await runtimeApi.steerFollowUp(session.sessionId, followUpId);
      setSession(result.session);
    } catch (error) {
      reportError(error);
    }
  }, [reportError, session, setSession]);

  return { queueIfActive, removeFollowUp, steerFollowUp };
}
