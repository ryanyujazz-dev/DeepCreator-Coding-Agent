import {
  CircleDot,
  ChevronDown,
  FolderSearch,
  PencilLine,
  TerminalSquare,
  TestTube2,
  Wrench
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Activity,
  ActivityIndicator,
  ActivitySlot,
  Changes,
  DisplaySegment
} from "../../shared/contracts/runtime";
import { runningCommandElapsed } from "../../shared/projections/activityTiming";
import { useStreamText } from "../stream/useStreamText";
import { ActivityAggregateRenderer, ModificationFileRow } from "./ActivityGroupRenderer";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingLoader } from "./ThinkingLoader";

function indicatorIcon(indicator: ActivityIndicator) {
  if (indicator.mode === "thinking") return <CircleDot size={13} />;
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
  const commandRunning = activity?.status === "running" && activity.tool?.toolName === "run_command";
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
  return (
    <article className={`work-step tool-step display-activity-slot is-${slot.logicalState}${isThinking ? " is-thinking" : ""}`}>
      <div className="work-dot">{isThinking ? <ThinkingLoader size={14} /> : indicatorIcon(slot.visual)}</div>
      <div className="work-body">
        {liveFile
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
              <strong className={`activity-slot-label ${slot.logicalState === "active" ? "working-glow" : ""}`}>
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
        <MarkdownContent fragments={text.fragments} stable={text.stable} streaming={streaming} />
      </div>
    </article>
  );
}

export function DisplaySegmentRenderer({
  segment,
  activities,
  changes,
  onOpenFile,
  onStopCommand,
  onTextFrame,
  runActive
}: {
  segment: DisplaySegment;
  activities: Parameters<typeof ActivityAggregateRenderer>[0]["activities"];
  changes: Changes;
  onOpenFile: (path: string) => void;
  onStopCommand: (commandId: string) => void;
  onTextFrame?: () => void;
  runActive: boolean;
}) {
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
          activities={activities}
          aggregate={segment.aggregate}
          changes={changes}
          key="aggregate"
          onOpenFile={onOpenFile}
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
