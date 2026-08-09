import { Activity, Run } from "../contracts/runtime";
import { DisplayProjectionOptions, projectDisplayTimeline } from "./displaySegments";
import { DisplayTimelineEntry } from "./types";

function isTool(activity: Activity): boolean {
  return Boolean(activity.tool)
    && activity.tool?.action !== "task"
    && activity.tool?.action !== "plan";
}

function executionStarted(activity: Activity): boolean {
  if (activity.tool?.toolName !== "apply_patch") return true;
  return activity.draft?.state === "applying"
    || activity.draft?.state === "applied"
    || (activity.draft?.state === "failed" && activity.kind === "file_mutation");
}

/**
 * Rebuilds the semantic Responses order without exposing raw SSE rows. Hosted
 * tools stay at their provider output index; local tools start only after the
 * sealed model step. An apply_patch draft and its later execution are distinct
 * presentation phases backed by the same durable Activity facts.
 */
export function responsesDisplayActivities(run: Pick<Run, "activities" | "outputItems">): Activity[] {
  const outputItems = run.outputItems ?? [];
  if (outputItems.length === 0) return run.activities;
  const activitiesByStep = new Map<string, Activity[]>();
  for (const activity of run.activities) {
    if (!activity.modelStepId) continue;
    activitiesByStep.set(activity.modelStepId, [...(activitiesByStep.get(activity.modelStepId) ?? []), activity]);
  }
  const itemsByStep = new Map<string, typeof outputItems>();
  for (const item of outputItems) {
    itemsByStep.set(item.modelStepId, [...(itemsByStep.get(item.modelStepId) ?? []), item]);
  }
  const stepOrder: string[] = [];
  for (const activity of run.activities) {
    if (activity.modelStepId && !stepOrder.includes(activity.modelStepId)) stepOrder.push(activity.modelStepId);
  }
  for (const item of outputItems) {
    if (!stepOrder.includes(item.modelStepId)) stepOrder.push(item.modelStepId);
  }

  const projectedStep = (modelStepId: string): Activity[] => {
    const stepActivities = activitiesByStep.get(modelStepId) ?? [];
    const items = [...(itemsByStep.get(modelStepId) ?? [])]
      .sort((left, right) => left.outputIndex - right.outputIndex || left.sequence - right.sequence);
    const output: Activity[] = [];
    const used = new Set<string>();
    for (const item of items) {
      if (item.type === "reasoning") {
        const thinking = stepActivities.find((activity) => activity.kind === "thinking");
        if (thinking && !used.has(thinking.activityId)) {
          output.push(thinking);
          used.add(thinking.activityId);
        }
        continue;
      }
      const activity = stepActivities.find((candidate) => candidate.modelItemId === item.itemId);
      if (!activity) continue;
      if (item.type === "message") {
        output.push(item.citations ? { ...activity, citations: item.citations } : activity);
        used.add(activity.activityId);
        continue;
      }
      if (item.type === "hosted_tool") {
        output.push(item.searchQuery ? {
          ...activity,
          body: item.searchQuery,
          tool: activity.tool ? { ...activity.tool, normalizedTarget: item.searchQuery } : activity.tool
        } : activity);
        used.add(activity.activityId);
        continue;
      }
      if (item.type === "custom" && item.toolName === "apply_patch") {
        output.push({
          ...activity,
          activityId: `${activity.activityId}:draft`,
          draft: {
            kind: "apply_patch",
            state: activity.draft?.state ?? (item.status === "completed" ? "unapplied" : "generating"),
            text: item.draft ?? activity.draft?.text ?? ""
          },
          finishedAt: item.status === "completed" ? activity.startedAt : undefined,
          kind: "thinking",
          status: item.status === "completed" ? "suspended" : "running"
        });
      }
    }
    for (const activity of stepActivities) {
      if (used.has(activity.activityId) || activity.kind === "thinking") continue;
      if (isTool(activity) && executionStarted(activity)) output.push(activity);
      else if (!isTool(activity)) output.push(activity);
    }
    return output;
  };

  const output: Activity[] = [];
  const emittedSteps = new Set<string>();
  for (const activity of run.activities) {
    if (activity.modelStepId) {
      if (!emittedSteps.has(activity.modelStepId)) {
        output.push(...projectedStep(activity.modelStepId));
        emittedSteps.add(activity.modelStepId);
      }
      continue;
    }
    output.push(activity);
  }
  for (const modelStepId of stepOrder) {
    if (emittedSteps.has(modelStepId)) continue;
    output.push(...projectedStep(modelStepId));
  }
  return output;
}

export function projectResponsesDisplayTimeline(
  run: Pick<Run, "activities" | "outputItems" | "runId">,
  options: DisplayProjectionOptions = {}
): DisplayTimelineEntry[] {
  const activities = responsesDisplayActivities(run);
  return projectDisplayTimeline(run, activities, options);
}
