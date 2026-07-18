import { Event, EventType, isRunDone, Session } from "../contracts/runtime";

export type EventDraft = Pick<Event, "data" | "scope" | "type">;

const ACTIVITY_UPDATE_TYPES = new Set<EventType>(["activity.updated", "activity.finished"]);

export function assertEventTransition(session: Session, draft: EventDraft): void {
  if (draft.scope.sessionId !== session.sessionId) {
    throw new Error("Event session scope does not match the target session.");
  }
  if (draft.type === "session.created") throw new Error("A session can only be created once.");
  if (draft.type === "session.updated") return;

  const run = session.runs.find((item) => item.runId === draft.scope.runId);
  if (draft.type === "run.started") {
    if (!draft.scope.runId) throw new Error("run.started requires runId.");
    if (run) throw new Error("Run already exists.");
    return;
  }
  if (!run) throw new Error(`${draft.type} requires an existing Run.`);

  if (draft.type === "run.finished") {
    if (isRunDone(run.status)) throw new Error("Run is already finished.");
    return;
  }
  if (isRunDone(run.status)) throw new Error(`Cannot append ${draft.type} after Run completion.`);

  if (draft.type === "activity.started") {
    if (run.status !== "running" && run.status !== "waiting") {
      throw new Error("Activity can only start while a Run is active.");
    }
    if (!draft.scope.activityId) throw new Error("activity.started requires activityId.");
    if (run.activities.some((activity) => activity.activityId === draft.scope.activityId)) {
      throw new Error("Activity already exists.");
    }
    return;
  }

  if (ACTIVITY_UPDATE_TYPES.has(draft.type)) {
    const activity = run.activities.find((item) => item.activityId === draft.scope.activityId);
    if (!activity) throw new Error(`${draft.type} requires an existing Activity.`);
    if (activity.status !== "running") throw new Error(`Cannot append ${draft.type} to a finished Activity.`);
  }
}
