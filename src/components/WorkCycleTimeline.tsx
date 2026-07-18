import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { projectOperationGroups } from "../../shared/operationGroupProjector";
import { CycleView, WorkspaceDeltaView, isTerminalCycle } from "../../shared/runtimeTypes";
import { ActivityRenderer } from "./ActivityRenderer";
import { ChangePanel } from "./ChangePanel";
import { OperationGroupRenderer } from "./OperationGroupRenderer";

function elapsed(cycle: CycleView): string {
  const seconds = Math.max(0, Math.floor(((cycle.settledAt ? new Date(cycle.settledAt).getTime() : Date.now()) - new Date(cycle.startedAt).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function WorkCycleTimeline({
  cycle,
  onOpenFile,
  onOpenReview
}: {
  cycle: CycleView;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: WorkspaceDeltaView) => void;
}) {
  const active = !isTerminalCycle(cycle.phase);
  const visibleUnits = active
    ? cycle.units
    : cycle.units.filter(
        (unit) => !(unit.kind === "message" && unit.body.trim() === cycle.finalResponse.trim())
      );
  const timelineEntries = projectOperationGroups(cycle, visibleUnits);
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
        <span className={active && cycle.phase !== "awaiting_approval" ? "working-glow" : ""}>{active ? (cycle.phase === "awaiting_approval" ? "等待批准" : "正在工作") : cycle.phase === "succeeded" ? "工作完成" : cycle.phase === "cancelled" ? "已取消" : "工作失败"}</span>
        <span>{elapsed(cycle)}</span><ChevronDown size={13} />
      </button>
      {expanded && timelineEntries.length > 0 && (
        <section className="work-process" aria-label="工作过程">
          {timelineEntries.map((entry) => entry.type === "operation_group"
            ? <OperationGroupRenderer
                group={entry.group}
                key={entry.entryKey}
                onOpenFile={onOpenFile}
                units={visibleUnits}
                workspaceDelta={cycle.workspaceDelta}
              />
            : <ActivityRenderer cycleActive={active} key={entry.entryKey} onOpenFile={onOpenFile} unit={entry.unit} />)}
        </section>
      )}
      {!active && (
        <section className="final-answer">
          {(cycle.finalResponse || cycle.failure || "本次工作未产生回答。").split(/\n{2,}/).map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph}</p>)}
        </section>
      )}
      {!active && <ChangePanel delta={cycle.workspaceDelta} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />}
    </div>
  );
}
