import {
  Blocks,
  ChevronDown,
  FolderSearch,
  PencilLine,
  TerminalSquare,
  TestTube2,
  Wrench
} from "lucide-react";
import React, { useEffect, useState } from "react";
import {
  Activity,
  Changes
} from "../../shared/contracts/runtime";
import { ActivityIndicator, ActivitySlot, DisplaySegment } from "../../shared/projections/types";
import { isSkillActivity } from "../../shared/projections/activityPresentation";
import { runningCommandElapsed } from "../../shared/projections/activityTiming";
import { useStreamText } from "../stream/useStreamText";
import { ActivityAggregateRenderer, ModificationFileRow } from "./ActivityGroupRenderer";
import { MarkdownContent } from "./MarkdownContent";

function indicatorIcon(indicator: Extract<ActivityIndicator, { mode: "tool" }>) {
  if (indicator.category === "modify") return <PencilLine size={13} />;
  if (indicator.category === "verify") return <TestTube2 size={13} />;
  if (indicator.category === "execute") return <TerminalSquare size={13} />;
  if (indicator.category === "inspect" || indicator.category === "search") return <FolderSearch size={13} />;
  return <Wrench size={13} />;
}

function ActivitySlotView({
  slot,
  activity,
  onOpenFile,
  onStopCommand
}: {
  slot: ActivitySlot;
  activity?: Activity;
  onOpenFile: (path: string) => void;
  onStopCommand: (commandId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const skillActivity = Boolean(activity && isSkillActivity(activity));
  const commandRunning = activity?.status === "running"
    && (activity.tool?.toolName === "run_command" || activity.tool?.toolName === "run_skill_script");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!commandRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity?.activityId, activity?.startedAt, commandRunning]);

  const commandElapsed = runningCommandElapsed(activity, now);
  const target = activity?.tool?.normalizedTarget.replaceAll("\\", "/");
  const liveFile = activity?.status === "running" && activity.tool?.action === "modify"
    ? (activity.files?.find((file) => file.path.replaceAll("\\", "/") === target)
      ?? activity.liveFiles?.find((file) => file.path.replaceAll("\\", "/") === target)
      ?? activity.files?.[0]
      ?? activity.liveFiles?.[0])
    : undefined;
  const isThinking = slot.visual.mode === "thinking";
  const patchDraft = activity?.draft;
  const nativeSearch = activity?.tool?.toolName === "web_search" && activity.modelItemId;
  // P1: a slot shows "in-progress" styling ONLY while its own tool is running.
  // continuationActive (this segment is the run's last/active one) no longer
  // counts — once the tool is done (logicalState === "empty") it never reads as
  // in-progress, even if it is the continuation target.
  const slotActive = slot.logicalState === "active";
  const skillDetail = activity?.error || activity?.body;
  const skillExpandable = skillActivity && Boolean(skillDetail || activity?.command?.commandId);
  return (
    <article className={`work-step tool-step display-activity-slot is-${slot.logicalState}${slotActive ? " is-active" : ""}${isThinking ? " is-thinking" : ""}${skillActivity ? " is-skill" : ""}`}>
      {slot.visual.mode === "tool" && <div className="work-dot">{skillActivity ? <Blocks size={13} /> : indicatorIcon(slot.visual)}</div>}
      <div className="work-body">
        {skillActivity
          ? skillExpandable
            ? (
                <div className="activity-slot-command skill-activity-detail">
                  <button
                    aria-expanded={expanded}
                    className="activity-slot-toggle"
                    onClick={() => setExpanded((value) => !value)}
                    type="button"
                  >
                    <strong className={`activity-slot-label ${slotActive ? "working-glow" : ""}`}>
                      <span className="activity-slot-label-text">{slot.visual.label}</span>
                      {commandElapsed && <span className="activity-slot-elapsed">{commandElapsed}</span>}
                    </strong>
                    <ChevronDown size={12} />
                  </button>
                  {expanded && (
                    <div className="activity-slot-command-detail">
                      <pre className="activity-output">{skillDetail || "Skill 脚本仍在运行，暂时没有输出。"}</pre>
                      {commandRunning && activity?.command?.commandId && (
                        <button className="command-stop-button" onClick={() => onStopCommand(activity.command!.commandId!)} type="button">
                          停止脚本
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            : (
                <strong className={`activity-slot-label ${slotActive ? "working-glow" : ""}`}>
                  <span className="activity-slot-label-text">{slot.visual.label}</span>
                </strong>
              )
          : patchDraft
          ? (
              <div className="activity-slot-command responses-patch-draft">
                <button
                  aria-expanded={expanded}
                  className="activity-slot-toggle"
                  onClick={() => setExpanded((value) => !value)}
                  type="button"
                >
                  <strong className={`activity-slot-label ${slotActive ? "working-glow" : ""}`}>
                    <span className="activity-slot-label-text">{slot.visual.label}</span>
                    <span className={`responses-draft-state is-${patchDraft.state}`}>{patchDraft.state === "applied" ? "已应用" : "未应用"}</span>
                  </strong>
                  <ChevronDown size={12} />
                </button>
                {expanded && <pre className="activity-output responses-patch-preview">{patchDraft.text || "补丁正文尚未到达。"}</pre>}
              </div>
            )
          : nativeSearch
            ? (
                <div className="activity-slot-command responses-search-detail">
                  <button
                    aria-expanded={expanded}
                    className="activity-slot-toggle"
                    onClick={() => setExpanded((value) => !value)}
                    type="button"
                  >
                    <strong className={`activity-slot-label ${slotActive ? "working-glow" : ""}`}>{slot.visual.label}</strong>
                    <ChevronDown size={12} />
                  </button>
                  {expanded && <p className="muted-line">查询：{activity.body || activity.tool?.normalizedTarget || "等待服务端返回"}</p>}
                </div>
              )
        : liveFile
          ? <ModificationFileRow active file={liveFile} onOpenFile={onOpenFile} showIcon={false} />
          : commandRunning
            ? (
                <div className="activity-slot-command">
                  <button
                    aria-expanded={expanded}
                    className="activity-slot-toggle"
                    onClick={() => setExpanded((value) => !value)}
                    type="button"
                  >
                    <strong className="activity-slot-label working-glow">
                      <span className="activity-slot-label-text">{slot.visual.label}</span>
                      {commandElapsed && <span className="activity-slot-elapsed">{commandElapsed}</span>}
                    </strong>
                    <ChevronDown size={12} />
                  </button>
                  {expanded && (
                    <div className="activity-slot-command-detail">
                      <pre className="activity-output">{activity.body || "命令仍在运行，暂时没有输出。"}</pre>
                      {activity.command?.commandId && (
                        <button className="command-stop-button" onClick={() => onStopCommand(activity.command!.commandId!)} type="button">
                          停止命令
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
          : (
              <strong className={`activity-slot-label ${slotActive ? "working-glow" : ""}`}>
                <span className="activity-slot-label-text">{slot.visual.label}</span>
                {commandElapsed && <span className="activity-slot-elapsed">{commandElapsed}</span>}
              </strong>
            )}
      </div>
    </article>
  );
}

function MainContentSlot({
  activity,
  onTextFrame,
  runActive
}: {
  activity: NonNullable<DisplaySegment["mainActivity"]>;
  onTextFrame?: () => void;
  runActive: boolean;
}) {
  const streaming = runActive && activity.status === "running";
  const text = useStreamText(activity.body, streaming, onTextFrame);
  return (
    <article className="work-step content-step">
      <div className="work-body">
        <MarkdownContent citations={activity.citations} fragments={text.fragments} stable={text.stable} streaming={streaming} />
      </div>
    </article>
  );
}

export function DisplaySegmentRenderer({
  segment,
  activities,
  changes,
  onOpenFile,
  onOpenAgent,
  onStopCommand,
  onTextFrame,
  runActive,
  // continuationActive is still passed by RunTimeline (and asserted by
  // designSystem.test.ts) but no longer drives any styling after the P1 change
  // (a done tool/aggregate never reads as in-progress). Renamed to _ to mark it
  // intentionally unused until the prop is removed from the call site.
  continuationActive: _continuationActive = false
}: {
  segment: DisplaySegment;
  activities: Parameters<typeof ActivityAggregateRenderer>[0]["activities"];
  changes: Changes;
  onOpenFile: (path: string) => void;
  onOpenAgent: (childSessionId: string, delegationId: string, title?: string) => void;
  onStopCommand: (commandId: string) => void;
  onTextFrame?: () => void;
  runActive: boolean;
  continuationActive?: boolean;
}) {
  // The aggregate, when present, has REPLACED the activity slot for this span
  // (a content boundary closed a ≥2-tool span). So slots are only shown when
  // there is NO aggregate. The projection guarantees a segment has either an
  // aggregate or activity slots, never both.
  const activityUsesSeedSlot = !segment.mainActivity && !segment.aggregate && segment.activitySlots.length > 0;
  const seedSlot = activityUsesSeedSlot ? segment.activitySlots[0] : undefined;
  const remainingSlots = seedSlot ? segment.activitySlots.slice(1) : segment.activitySlots;
  return (
    <section className="display-segment" data-segment-id={segment.segmentId}>
      {segment.mainActivity && (
        <div className="display-segment-primary" key="primary">
          <MainContentSlot activity={segment.mainActivity} onTextFrame={onTextFrame} runActive={runActive} />
        </div>
      )}
      {seedSlot && (
        <div className="display-segment-primary" key={seedSlot.slotId}>
          <ActivitySlotView
            activity={activities.find((activity) => activity.activityId === seedSlot.visual.sourceActivityId)}
            onOpenFile={onOpenFile}
            onStopCommand={onStopCommand}
            slot={seedSlot}
          />
        </div>
      )}
      {segment.aggregate && (
        <ActivityAggregateRenderer
          active={false}
          activities={activities}
          aggregate={segment.aggregate}
          changes={changes}
          key="aggregate"
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
      )}
      {remainingSlots.map((slot) => (
        <div className="display-segment-activity" key={slot.slotId}>
          <ActivitySlotView
            activity={activities.find((activity) => activity.activityId === slot.visual.sourceActivityId)}
            onOpenFile={onOpenFile}
            onStopCommand={onStopCommand}
            slot={slot}
          />
        </div>
      ))}
    </section>
  );
}
