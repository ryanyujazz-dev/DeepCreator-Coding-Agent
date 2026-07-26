import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReasoningStep, Run, isRunDone } from "../../shared/contracts/runtime";
import {
  SCROLL_FOLLOW_EDGE_THRESHOLD,
  ScrollFollowMode,
  resolveScrollFollowMode
} from "../stream/followScroll";
import { useStreamText } from "../stream/useStreamText";

const POLL_INTERVAL_MS = 200;

function ReasoningStepTrace({
  index,
  onStreamFrame,
  step,
  streaming
}: {
  index: number;
  onStreamFrame: () => void;
  step: ReasoningStep;
  streaming: boolean;
}) {
  const streamed = useStreamText(step.text, streaming, onStreamFrame);
  return (
    <article
      aria-label={`思考步骤 ${index + 1}`}
      className={`reasoning-step${streaming ? " is-streaming" : ""}`}
      data-model-step-id={step.modelStepId}
      role="listitem"
    >
      <p>
        <span>{streamed.stable}</span>
        {streamed.fragments.map((fragment) => (
          <span className={`streaming-fragment is-frame-${fragment.frame}`} key={fragment.id}>{fragment.text}</span>
        ))}
      </p>
    </article>
  );
}

export function ReasoningTrace({ run }: { run?: Run }) {
  const steps = run?.reasoningSteps ?? [];
  const done = run ? isRunDone(run.status) : true;
  const reasoningTitle = run?.reasoningTitle ?? "正在思考";
  const titleStreaming = run?.status === "running";
  const [expanded, setExpanded] = useState(() => Boolean(run && !done));
  const traceRef = useRef<HTMLDivElement>(null);
  const followModeRef = useRef<ScrollFollowMode>("follow");
  const [notAtBottom, setNotAtBottom] = useState(false);

  const distanceFromBottom = useCallback((element: HTMLElement) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ), []);
  const scrollToBottom = useCallback(() => {
    const trace = traceRef.current;
    if (trace) trace.scrollTop = trace.scrollHeight;
  }, []);
  const followLatest = useCallback(() => {
    if (followModeRef.current !== "follow") return;
    requestAnimationFrame(scrollToBottom);
  }, [scrollToBottom]);
  const setFollowMode = useCallback((mode: ScrollFollowMode) => {
    followModeRef.current = mode;
    setNotAtBottom(mode === "paused");
  }, []);

  useEffect(() => {
    setExpanded(Boolean(run && !done));
  }, [done, run?.runId]);

  useEffect(() => {
    setFollowMode("follow");
    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
  }, [expanded, run?.runId, scrollToBottom, setFollowMode]);

  useEffect(() => {
    if (!expanded || done) return;
    const timer = window.setInterval(followLatest, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [done, expanded, followLatest]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distance = distanceFromBottom(element);
    const nextMode = resolveScrollFollowMode(followModeRef.current, distance);
    if (nextMode !== followModeRef.current) setFollowMode(nextMode);
    if (nextMode === "follow") setNotAtBottom(false);
    else setNotAtBottom(distance >= SCROLL_FOLLOW_EDGE_THRESHOLD);
  }, [distanceFromBottom, setFollowMode]);

  const pauseForUpwardScroll = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) setFollowMode("paused");
  }, [setFollowMode]);

  const resumeFollowing = useCallback(() => {
    setFollowMode("follow");
    scrollToBottom();
  }, [scrollToBottom, setFollowMode]);

  if (steps.length === 0) return null;
  const statusLabel = run?.status === "completed"
    ? "已完成"
    : run?.status === "failed"
      ? "已失败"
      : run?.status === "cancelled"
        ? "已取消"
        : run?.status === "waiting"
          ? "等待中"
          : "实时";
  return (
    <section className={`environment-section reasoning-section ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <header>
        <button
          aria-expanded={expanded}
          className="reasoning-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span
            aria-atomic="true"
            aria-live="polite"
            className="reasoning-title"
            title={reasoningTitle}
          >
            <span className="reasoning-title-transition" key={reasoningTitle}>
              <span className={titleStreaming ? "purpose-sweep" : undefined}>{reasoningTitle}</span>
            </span>
          </span>
          <small>{statusLabel}</small>
          <ChevronDown size={13} />
        </button>
      </header>
      {expanded && (
        <div className={`reasoning-trace-shell${notAtBottom ? " is-paused" : ""}`}>
          <div
            aria-live={done ? "off" : "polite"}
            className={`reasoning-trace ${done ? "is-terminal" : "is-streaming"}`}
            onScroll={handleScroll}
            onWheel={pauseForUpwardScroll}
            ref={traceRef}
            role="list"
          >
            {steps.map((step, index) => (
              <ReasoningStepTrace
                index={index}
                key={step.modelStepId}
                onStreamFrame={followLatest}
                step={step}
                streaming={!done && index === steps.length - 1}
              />
            ))}
          </div>
          {notAtBottom && (
            <button
              aria-label="滚动到思考过程底部"
              className="reasoning-scroll-to-bottom"
              onClick={resumeFollowing}
              title="滚动到底部并继续跟随"
              type="button"
            >
              <ChevronDown size={15} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
