import { ChevronDown, Lightbulb, PanelRightOpen } from "lucide-react";
import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, Plan } from "../../shared/contracts/runtime";
import { useStreamText } from "../stream/useStreamText";
import { MarkdownContent } from "./MarkdownContent";

function planStateLabel(activity: Activity, runActive: boolean, plan?: Plan): string {
  if (activity.status === "running") return runActive ? "正在编写" : "生成中断";
  if (activity.status === "failed") return "生成中断";
  if (plan?.status === "approved") return "已批准";
  if (plan?.status === "rejected") return "待调整";
  if (plan?.status === "superseded") return "旧版本";
  return "待审阅";
}

export function InlinePlanCard({
  activity,
  onOpen,
  onTextFrame,
  plan,
  runActive
}: {
  activity: Activity;
  onOpen: () => void;
  onTextFrame?: () => void;
  plan?: Plan;
  runActive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedHeight, setExpandedHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const streaming = runActive && activity.status === "running";
  const wasStreaming = useRef(streaming);
  const text = useStreamText(activity.body, streaming, onTextFrame);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    setExpandedHeight(content.scrollHeight);
    if (wasStreaming.current && !streaming && !expanded) {
      content.scrollTop = 0;
      stickToBottom.current = true;
    } else if (!expanded && streaming && stickToBottom.current) {
      content.scrollTop = content.scrollHeight;
    }
    wasStreaming.current = streaming;
  }, [activity.body, expanded, streaming, text]);

  useEffect(() => {
    const content = contentRef.current;
    const measured = content?.firstElementChild;
    if (!content || !measured || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setExpandedHeight(content.scrollHeight));
    observer.observe(measured);
    return () => observer.disconnect();
  }, []);

  return (
    <article className={`inline-plan-card is-${activity.status} ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <header>
        <div className="inline-plan-label">
          <Lightbulb size={14} />
          <span>方案</span>
          {plan && <small>第 {plan.revision} 版</small>}
          <small className={`inline-plan-state is-${plan?.status ?? activity.status}`}>{planStateLabel(activity, runActive, plan)}</small>
        </div>
        <button aria-label="在右侧栏打开计划" onClick={onOpen} title="在右侧栏打开" type="button">
          <PanelRightOpen size={14} />
        </button>
      </header>
      <div
        className="inline-plan-content"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
        }}
        ref={contentRef}
        style={expanded ? { maxHeight: `${expandedHeight + 64}px` } as CSSProperties : undefined}
      >
        {activity.body
          ? <MarkdownContent fragments={text.fragments} stable={text.stable} streaming={streaming} />
          : <p className="inline-plan-empty working-glow">正在组织计划内容</p>}
      </div>
      <footer aria-hidden={!activity.body}>
        <button
          aria-expanded={expanded}
          aria-label={expanded ? "收起计划" : "展开计划"}
          disabled={!activity.body}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? "收起" : "展开"}
          type="button"
        >
          <ChevronDown size={15} />
        </button>
      </footer>
    </article>
  );
}
