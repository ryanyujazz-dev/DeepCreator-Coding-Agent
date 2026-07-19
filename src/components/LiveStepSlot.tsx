import {
  CheckCircle2,
  CircleAlert,
  FolderSearch,
  PencilLine,
  TerminalSquare,
  TestTube2,
  Wrench
} from "lucide-react";
import { LiveStep } from "../../shared/contracts/runtime";
import { useStreamText } from "../stream/useStreamText";
import { MarkdownContent } from "./MarkdownContent";

function toolIcon(liveStep: Extract<LiveStep, { mode: "tools" }>) {
  if (liveStep.status === "failed") return <CircleAlert size={13} />;
  if (liveStep.category === "modify") return <PencilLine size={13} />;
  if (liveStep.category === "verify") return <TestTube2 size={13} />;
  if (liveStep.category === "execute") return <TerminalSquare size={13} />;
  if (liveStep.category === "inspect" || liveStep.category === "search") return <FolderSearch size={13} />;
  if (liveStep.category === "external" || liveStep.category === "mixed") return <Wrench size={13} />;
  return <CheckCircle2 size={13} />;
}

function LiveMessageStep({
  activity,
  onTextFrame,
  runActive
}: {
  activity: Extract<LiveStep, { mode: "message" }>["activity"];
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

export function LiveStepSlot({
  liveStep,
  onTextFrame,
  runActive
}: {
  liveStep: LiveStep;
  onTextFrame?: () => void;
  runActive: boolean;
}) {
  if (liveStep.mode === "thinking") {
    return (
      <article className="work-step thinking-step is-expanded">
        <div className="work-body">
          <strong className="working-glow">正在思考</strong>
        </div>
      </article>
    );
  }
  if (liveStep.mode === "message") {
    return <LiveMessageStep activity={liveStep.activity} onTextFrame={onTextFrame} runActive={runActive} />;
  }
  return (
    <article className={`work-step tool-step is-${liveStep.status}`}>
      <div className="work-dot">{toolIcon(liveStep)}</div>
      <div className="work-body">
        <strong className={liveStep.status === "running" ? "working-glow" : ""}>{liveStep.summaryLabel}</strong>
        {liveStep.currentTarget && <p className="muted-line">{liveStep.currentTarget}</p>}
      </div>
    </article>
  );
}
