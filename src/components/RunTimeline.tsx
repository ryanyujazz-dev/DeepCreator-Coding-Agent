import { ChevronDown, ChevronRight } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Run, Changes, Plan, isRunDone } from "../../shared/contracts/runtime";
import { projectDisplayTimeline } from "../../shared/projections/displaySegments";
import { DisplayTimelineEntry } from "../../shared/projections/types";
import { ActivityView } from "./ActivityView";
import { ChangePanel } from "./ChangePanel";
import { DisplaySegmentRenderer } from "./DisplaySegmentRenderer";
import { MarkdownContent } from "./MarkdownContent";

type UserMessageEntry = Extract<DisplayTimelineEntry, { type: "activity" }>;

export type RunConversationTurn = {
  entries: DisplayTimelineEntry[];
  turnId: string;
  userMessage?: UserMessageEntry;
};

export function splitTimelineIntoConversationTurns(runId: string, entries: DisplayTimelineEntry[]): RunConversationTurn[] {
  const turns: RunConversationTurn[] = [{ entries: [], turnId: `turn:${runId}:prompt` }];
  for (const entry of entries) {
    if (entry.type === "activity" && entry.activity.kind === "user_message") {
      turns.push({ entries: [], turnId: `turn:${entry.entryId}`, userMessage: entry });
      continue;
    }
    turns[turns.length - 1].entries.push(entry);
  }
  return turns;
}

function elapsed(run: Run): string {
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function RunTimeline({
  run,
  onOpenAgent,
  onOpenFile,
  onOpenReview,
  onStopCommand,
  onOpenPlan,
  plans,
  onTextFrame
}: {
  run: Run;
  onOpenAgent?: (childSessionId: string, delegationId: string, title?: string) => void;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
  onStopCommand: (commandId: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  plans: Plan[];
  onTextFrame?: () => void;
}) {
  const active = !isRunDone(run.status);
  const suppressedContentActivityIds = new Set(active
    ? []
    : run.activities
        .filter((activity) => activity.kind === "message" && activity.body.trim() === run.answer.trim())
        .map((activity) => activity.activityId));
  const timelineEntries = projectDisplayTimeline(run, run.activities, { suppressedContentActivityIds });
  const conversationTurns = splitTimelineIntoConversationTurns(run.runId, timelineEntries);
  const activeDisplaySegmentId = run.status === "running"
    ? [...timelineEntries].reverse().find((entry) => entry.type === "display_segment")?.entryId
    : undefined;
  const [expanded, setExpanded] = useState(active);
  useEffect(() => setExpanded(active), [active]);
  return (
    <>
      {conversationTurns.map((turn, turnIndex) => {
        const initialTurn = turnIndex === 0;
        const lastTurn = turnIndex === conversationTurns.length - 1;
        const showRunStream = initialTurn || (expanded && turn.entries.length > 0) || (lastTurn && !active);
        return (
          <div className="conversation-turn" key={turn.turnId}>
            {initialTurn
              ? <section className="user-turn"><p>{run.prompt}</p></section>
              : turn.userMessage && (
                <ActivityView
                  activity={turn.userMessage.activity}
                  onOpenFile={onOpenFile}
                  onOpenPlan={onOpenPlan}
                  onTextFrame={onTextFrame}
                  runActive={active}
                />
              )}
            {showRunStream && (
              <div className={`run-stream ${active ? "" : "completed-stream"}`}>
                {initialTurn && (
                  <button
                    aria-expanded={expanded}
                    className={`run-status-pill ${active ? "is-live" : ""} ${expanded ? "is-expanded" : ""}`}
                    onClick={() => setExpanded((value) => !value)}
                    type="button"
                  >
                    <span>{active
                      ? (run.status === "waiting" ? "等待批准" : "正在工作")
                      : run.status === "completed" ? "工作完成" : run.status === "cancelled" ? "已取消" : "工作失败"}</span>
                    <span>{elapsed(run)}</span>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                )}
                {expanded && turn.entries.length > 0 && (
                  <section className="work-process" aria-label="工作过程">
                    {turn.entries.map((entry) => {
                      if (entry.type === "display_segment") {
                        return (
                          <DisplaySegmentRenderer
                            activities={run.activities}
                            changes={run.changes}
                            continuationActive={entry.entryId === activeDisplaySegmentId}
                            key={entry.entryId}
                            onOpenFile={onOpenFile}
                            onOpenAgent={onOpenAgent ?? (() => undefined)}
                            onStopCommand={onStopCommand}
                            onTextFrame={onTextFrame}
                            runActive={active}
                            segment={entry.segment}
                          />
                        );
                      }
                      return (
                        <ActivityView
                          activity={entry.activity}
                          key={entry.entryId}
                          onOpenFile={onOpenFile}
                          onOpenPlan={onOpenPlan}
                          onTextFrame={onTextFrame}
                          plan={plans.filter((plan) => plan.callId === entry.activity.tool?.callId).sort((left, right) => right.revision - left.revision)[0]}
                          runActive={active}
                        />
                      );
                    })}
                  </section>
                )}
                {lastTurn && !active && Boolean((run.status === "failed" ? run.error : run.answer) || run.error) && (
                  <section className="final-answer">
                    <MarkdownContent text={(run.status === "failed" ? run.error : undefined) || run.answer || run.error || ""} />
                  </section>
                )}
                {lastTurn && !active && <ChangePanel delta={run.changes} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
