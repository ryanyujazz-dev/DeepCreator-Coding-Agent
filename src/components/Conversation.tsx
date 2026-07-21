import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Changes, Session } from "../../shared/contracts/runtime";
import { RunTimeline } from "./RunTimeline";

// === 滚动跟随状态机 + 边缘渐变消隐(第一性设计)===
//
// 一、跟随状态机
//   follow - 定时器每 200ms 把 scrollTop 钉到 scrollHeight
//   paused - 定时器不做事,用户自由翻历史
//   转换靠 onScroll 的纯位置判断 + 滞后阈值
//
// 二、边缘渐变消隐(Codex 风格)
//   关键:蒙层必须挂在"不滚动的祖先"上,否则会被 overflow 裁切或跟随内容滚。
//   所以蒙层用 createPortal 渲染到 .conversation-main(overflow:hidden,不滚动),
//   而不是挂在 .conversation-scroll(overflow-y:auto,会裁切)内部。
//   - 顶部蒙层:紧贴 .conversation-main 顶部
//   - 底部蒙层:紧贴对话框上边缘(bottom = composer-dock 实际高度,用 ResizeObserver 动态测)

const RESUME_THRESHOLD = 8;
const PAUSE_THRESHOLD = 60;
const POLL_INTERVAL_MS = 200;
const EDGE_THRESHOLD = 8;

type FollowMode = "follow" | "paused";

export function Conversation({
  onOpenFile,
  onOpenPlan,
  onOpenReview,
  onStopCommand,
  session
}: {
  onOpenFile: (path: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  onOpenReview: (delta: Changes) => void;
  onStopCommand: (commandId: string) => void;
  session: Session | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const modeRef = useRef<FollowMode>("follow");
  const [notAtBottom, setNotAtBottom] = useState(false);
  const [notAtTop, setNotAtTop] = useState(false);
  // 底部蒙层的 bottom:从 main 底部到 composer 上沿的距离
  // (= composer 跟底部的 margin + composer 上方可能出现的 hud/notice 高度 + composer 自身高度)
  // 用 composer.offsetTop 反推:bottom = main.clientHeight - composer.offsetTop
  const [composerBottomOffset, setComposerBottomOffset] = useState(0);
  // 顶部偏移:.conversation-scroll 相对 .conversation-main 的 offsetTop
  const [scrollOffsetTop, setScrollOffsetTop] = useState(0);
  // Portal 目标:.conversation-main 元素
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // 找到 .conversation-main 作为 Portal 目标
  useLayoutEffect(() => {
    const parent = scrollRef.current?.parentElement;
    if (parent && parent.classList.contains("conversation-main")) {
      setPortalTarget(parent);
    }
  }, []);

  // 动态测量:顶部蒙层 top + 底部蒙层 bottom
  useLayoutEffect(() => {
    if (!portalTarget || !scrollRef.current) return;
    const scroll = scrollRef.current;
    const updateLayout = () => {
      // 顶部蒙层 top = scroll 相对 main 的 offsetTop
      setScrollOffsetTop(scroll.offsetTop);
      // 底部蒙层 bottom = composer 上沿距 main 底部的距离
      // composer 是 .conversation-main 的直接子元素(dock 已删除)
      const composer = portalTarget.querySelector(".composer") as HTMLElement | null;
      if (composer) {
        setComposerBottomOffset(portalTarget.clientHeight - composer.offsetTop);
      }
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(portalTarget);
    // 观察 composer 以及它的兄弟(hud/notice 等显隐会改变 composer 位置)
    const composer = portalTarget.querySelector(".composer");
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [portalTarget]);

  const distanceFromBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const setMode = useCallback((next: FollowMode) => {
    if (modeRef.current === next) return;
    modeRef.current = next;
    setNotAtBottom(next === "paused");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (modeRef.current !== "follow") return;
      scrollToBottom();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [scrollToBottom]);

  const handleScroll = useCallback((event: React.BaseSyntheticEvent) => {
    const el = event.currentTarget as HTMLElement;
    const distance = distanceFromBottom(el);
    if (modeRef.current === "follow") {
      if (distance > PAUSE_THRESHOLD) setMode("paused");
    } else {
      if (distance < RESUME_THRESHOLD) setMode("follow");
    }
    setNotAtTop(el.scrollTop >= EDGE_THRESHOLD);
    setNotAtBottom(distance >= EDGE_THRESHOLD);
  }, [distanceFromBottom, setMode]);

  useEffect(() => {
    setMode("follow");
    requestAnimationFrame(scrollToBottom);
  }, [session?.sessionId, setMode, scrollToBottom]);

  const runCount = session?.runs.length ?? 0;
  const prevRunCountRef = useRef(runCount);
  useEffect(() => {
    if (runCount > prevRunCountRef.current) {
      setMode("follow");
      requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    }
    prevRunCountRef.current = runCount;
  }, [runCount, setMode, scrollToBottom]);

  const handleScrollToBottomClick = useCallback(() => {
    setMode("follow");
    scrollToBottom();
  }, [setMode, scrollToBottom]);

  // 蒙层通过 Portal 渲染到 .conversation-main
  // - 顶部蒙层:top = scrollOffsetTop(对话区顶部相对 main 的偏移),紧贴对话区上沿
  // - 底部蒙层:bottom = composerBottomOffset(composer 上沿距 main 底部),紧贴对话框上沿
  const fades = portalTarget ? createPortal(
    <>
      {notAtTop && (
        <div
          className="conversation-fade-top"
          style={{ top: `${scrollOffsetTop}px` }}
          aria-hidden="true"
        />
      )}
      {notAtBottom && (
        <div
          className="conversation-fade-bottom"
          style={{ bottom: `${composerBottomOffset}px` }}
          aria-hidden="true"
        />
      )}
    </>,
    portalTarget
  ) : null;

  return (
    <section
      className="conversation-scroll"
      onScroll={handleScroll}
      ref={scrollRef}
    >
      {session && session.runs.length > 0 ? (
        <div className="conversation-column">
          {session.runs.map((run) => (
            <div className="conversation-turn" key={run.runId}>
              <section className="user-turn"><p>{run.prompt}</p></section>
              <RunTimeline
                run={run}
                onOpenFile={onOpenFile}
                onOpenPlan={onOpenPlan}
                onOpenReview={onOpenReview}
                onStopCommand={onStopCommand}
                plans={session.plans.filter((plan) => plan.runId === run.runId)}
              />
            </div>
          ))}
          <div className="conversation-column-bottom-spacer" />
        </div>
      ) : (
        <div className="conversation-empty-state"><h1>我们该构建什么？</h1></div>
      )}
      {fades}
      {notAtBottom && (
        <button
          aria-label="滚动到底部"
          className="scroll-to-bottom-button"
          onClick={handleScrollToBottomClick}
          title="滚动到底部"
          type="button"
        >
          <ChevronDown size={18} />
        </button>
      )}
    </section>
  );
}
