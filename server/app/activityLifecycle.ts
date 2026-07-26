import { EventPayloadMap } from "../../shared/contracts/runtime";
import { EventPort, SessionPort } from "./runtimeRepo";
import { SystemPort } from "./systemPort";

type ActivityLifecycleInput = {
  activityId: string;
  runId: string;
  sessionId: string;
  store: EventPort & SessionPort;
};

function isActive(status: string): boolean {
  return status === "running" || status === "suspended";
}

export function finishActivity(
  input: ActivityLifecycleInput & { system: SystemPort },
  data: Omit<EventPayloadMap["activity.finished"], "finishedAt">
): boolean {
  const activity = input.store.getRun(input.runId)?.activities
    .find((item) => item.activityId === input.activityId);
  if (!activity) throw new Error("activity.finished requires an existing Activity.");
  if (!isActive(activity.status)) return false;

  input.store.append({
    activityId: input.activityId,
    data: { liveFiles: [], ...data, finishedAt: input.system.now() },
    runId: input.runId,
    sessionId: input.sessionId,
    type: "activity.finished"
  });
  return true;
}

export function updateActivity(
  input: ActivityLifecycleInput,
  data: EventPayloadMap["activity.updated"]
): boolean {
  const activity = input.store.getRun(input.runId)?.activities
    .find((item) => item.activityId === input.activityId);
  if (!activity) throw new Error("activity.updated requires an existing Activity.");
  if (!isActive(activity.status)) return false;

  input.store.append({
    activityId: input.activityId,
    data,
    runId: input.runId,
    sessionId: input.sessionId,
    type: "activity.updated"
  });
  return true;
}
