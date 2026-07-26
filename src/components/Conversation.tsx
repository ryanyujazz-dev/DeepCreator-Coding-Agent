import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Changes, Session } from "../../shared/contracts/runtime";
import {
  SCROLL_FOLLOW_EDGE_THRESHOLD,
  ScrollFollowMode,
  resolveScrollFollowMode
} from "../stream/followScroll";
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

const POLL_INTERVAL_MS = 200;

export function Conversation({
  notices,
  onOpenFile,
  onOpenPlan,
  onOpenReview,
  onStopCommand,
  session
}: {
  notices?: string[];
  onOpenFile: (path: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  onOpenReview: (delta: Changes) => void;
  onStopCommand: (commandId: string) => void;
  session: Session | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const modeRef = useRef<ScrollFollowMode>("follow");
  const [notAtBottom, setNotAtBottom] = useState(false);
  const [notAtTop, setNotAtTop] = useState(false);
  // 底部蒙层的 bottom:从 main 底部到 composer 上沿的距离。
  // HUD 依附 composer-stack 绝对悬浮，不参与布局，也不会改变这条边界。
  // 用 composer.offsetTop 反推:bottom = main.clientHeight - composer.offsetTop。
  const [composerBottomOffset, setComposerBottomOffset] = useState(0);
  // 顶部偏移:.conversation-scroll 相对 .conversation-main 的 offsetTop
  const [scrollOffsetTop, setScrollOffsetTop] = useState(0);
  // Portal 目标:.conversation-main 元素
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // 滚动按钮直接挂到 Composer 容器，天然继承所有响应式位移和宽度变化。
  const [composerPortalTarget, setComposerPortalTarget] = useState<HTMLElement | null>(null);

  // 找到 .conversation-main 作为 Portal 目标
  useLayoutEffect(() => {
    const parent = scrollRef.current?.parentElement;
    if (parent && parent.classList.contains("conversation-main")) {
      setPortalTarget(parent);
      setComposerPortalTarget(parent.querySelector<HTMLElement>(".composer-stack"));
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
      // 新任务使用 composer-stack，已有任务直接测量 composer，二者都以真实上沿为准。
      const composer = portalTarget.querySelector(".composer-stack, .composer") as HTMLElement | null;
      if (composer) {
        setComposerBottomOffset(portalTarget.clientHeight - composer.offsetTop);
      }
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(portalTarget);
    // 观察输入区容器；上下文条和 Composer 高度变化都会同步更新遮罩边界。
    const composer = portalTarget.querySelector(".composer-stack, .composer");
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

  const setMode = useCallback((next: ScrollFollowMode) => {
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
    const nextMode = resolveScrollFollowMode(modeRef.current, distance);
    if (modeRef.current === "follow") {
      if (nextMode === "paused") setMode("paused");
      // 跟随模式下强制认为在底部(蒙层/按钮都不显示),避免 distance 在阈值附近
      // 抖动导致 notAtBottom 在 true/false 之间反复切换 → 蒙层挂载/卸载 → 布局变化 → 抖动
      setNotAtBottom(false);
    } else {
      if (nextMode === "follow") setMode("follow");
      setNotAtBottom(distance >= SCROLL_FOLLOW_EDGE_THRESHOLD);
    }
    setNotAtTop(el.scrollTop >= SCROLL_FOLLOW_EDGE_THRESHOLD);
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

  // 蒙层通过 Portal 渲染到 .conversation-main，滚动按钮挂到 .composer-stack。
  // - 顶部蒙层:top = scrollOffsetTop(对话区顶部相对 main 的偏移),紧贴对话区上沿
  // - 底部蒙层:bottom = composerBottomOffset(composer 上沿距 main 底部),紧贴对话框上沿
  // - 滚动按钮:由 Composer 作为定位父级，因此始终跟随输入框的真实中心。
  const overlays = portalTarget ? createPortal(
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
  const scrollButton = composerPortalTarget && notAtBottom ? createPortal(
    <button
      aria-label="滚动到底部"
      className="scroll-to-bottom-button"
      onClick={handleScrollToBottomClick}
      title="滚动到底部"
      type="button"
    >
      <ChevronDown size={18} />
    </button>,
    composerPortalTarget
  ) : null;

  return (
    <section
      className="conversation-scroll"
      onScroll={handleScroll}
      ref={scrollRef}
    >
      {session && session.runs.length > 0 ? (
        <div className="conversation-column">
          {notices?.map((notice, index) => (
            <div className="conversation-notice" key={`notice-${index}`}>{notice}</div>
          ))}
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
      {overlays}
      {scrollButton}
    </section>
  );
}
