import { useCallback } from "react";
import { AccessMode, Mode, PlanEntry, QuestionAnswer, Session } from "../../../shared/contracts/runtime";
import { runtimeApi } from "../../runtimeApi";
import { browserPlatform } from "../../platform/browser";
import { SessionUpdater } from "./sessionEventStore";

export function useQuestionInteractions(input: {
  accessMode: AccessMode;
  mode: Mode;
  model: string;
  planEntry: PlanEntry;
  session: Session | null;
  setError: (message: string | null) => void;
  setSession: (next: SessionUpdater) => void;
}) {
  const { accessMode, mode, model, planEntry, session, setError, setSession } = input;
  const answerQuestion = useCallback(async (interactionId: string, answers: Record<string, QuestionAnswer>) => {
    if (!session) return;
    setError(null);
    try {
      const result = await runtimeApi.answerQuestion(session.sessionId, interactionId, answers);
      setSession(result.session);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [session, setError, setSession]);

  const interruptQuestion = useCallback(async (interactionId: string, prompt: string): Promise<boolean> => {
    if (!session) return false;
    setError(null);
    try {
      const result = await runtimeApi.interruptQuestion(session.sessionId, interactionId, {
        accessMode,
        mode,
        model,
        planEntry,
        prompt,
        requestId: browserPlatform.createId("question_interrupt")
      });
      setSession(result.session);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [accessMode, mode, model, planEntry, session, setError, setSession]);

  return { answerQuestion, interruptQuestion };
}
