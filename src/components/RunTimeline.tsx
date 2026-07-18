import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { projectGroups } from "../../shared/projections/groups";
import { Run, Changes, Plan, isRunDone } from "../../shared/contracts/runtime";
import { ActivityView } from "./ActivityView";
import { ChangePanel } from "./ChangePanel";
import { ActivityGroupRenderer } from "./ActivityGroupRenderer";
import { MarkdownContent } from "./MarkdownContent";

function elapsed(run: Run): string {
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function RunTimeline({
  run,
  onOpenFile,
  onOpenReview,
  onOpenPlan,
  plans,
  onTextFrame
}: {
  run: Run;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  plans: Plan[];
  onTextFrame?: () => void;
}) {
  const active = !isRunDone(run.status);
  const visibleUnits = active
    ? run.activities
    : run.activities.filter(
        (activity) => !(activity.kind === "message" && activity.body.trim() === run.answer.trim())
      );
  const timelineEntries = projectGroups(run, visibleUnits);
  const [expanded, setExpanded] = useState(active);
  useEffect(() => setExpanded(active), [active]);
  return (
    <div className={`run-stream ${active ? "" : "completed-stream"}`}>
      <button
        aria-expanded={expanded}
        className={`run-status-pill ${active ? "is-live" : ""} ${expanded ? "is-expanded" : ""}`}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>{active ? (run.status === "waiting" ? "等待批准" : "正在工作") : run.status === "completed" ? "工作完成" : run.status === "cancelled" ? "已取消" : "工作失败"}</span>
        <span>{elapsed(run)}</span><ChevronDown size={13} />
      </button>
      {expanded && timelineEntries.length > 0 && (
        <section className="work-process" aria-label="工作过程">
          {timelineEntries.map((entry) => entry.type === "activity_group"
            ? <ActivityGroupRenderer
                group={entry.group}
                key={entry.entryId}
                onOpenFile={onOpenFile}
                activities={visibleUnits}
                changes={run.changes}
              />
            : <ActivityView
                runActive={active}
                key={entry.entryId}
                onOpenFile={onOpenFile}
                onOpenPlan={onOpenPlan}
                onTextFrame={onTextFrame}
                plan={plans.filter((plan) => plan.callId === entry.activity.tool?.callId).sort((left, right) => right.revision - left.revision)[0]}
                activity={entry.activity}
              />)}
        </section>
      )}
      {!active && (
        <section className="final-answer">
          <MarkdownContent text={run.answer || run.error || "本次工作未产生回答。"} />
        </section>
      )}
      {!active && <ChangePanel delta={run.changes} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />}
    </div>
  );
}
