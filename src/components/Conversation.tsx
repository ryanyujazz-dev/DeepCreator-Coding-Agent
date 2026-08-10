import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Changes, Plan, Question, Session } from "../../shared/contracts/runtime";
import {
  SCROLL_FOLLOW_EDGE_THRESHOLD,
  ScrollFollowMode,
  resolveScrollFollowMode
} from "../stream/followScroll";
import { RunTimeline } from "./RunTimeline";
import { useStableCallback } from "../shared-ui/useStableCallback";

const EMPTY_PLANS: Plan[] = [];
const EMPTY_QUESTIONS: Question[] = [];

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
  onOpenAgent,
  onOpenFile,
  onOpenPlan,
  onOpenReview,
  onStopCommand,
  pendingRun,
  session
}: {
  notices?: string[];
  onOpenAgent: (childSessionId: string, delegationId: string, title?: string) => void;
  onOpenFile: (path: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  onOpenReview: (delta: Changes) => void;
  onStopCommand: (commandId: string) => void;
  pendingRun?: { key: string; label: string; prompt: string };
  session: Session | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const modeRef = useRef<ScrollFollowMode>("follow");
  // 内容容器(.conversation-column)ref —— 给 ResizeObserver observe。两个有内容的分支
  // (pendingRun / session)都绑它,React 在分支切换时自动把当前节点赋给 contentRef。
  // 用 HTMLDivElement 而非 HTMLElement:<div> 的 ref 期望精确的 HTMLDivElement(React ref
  // 类型不变,父类 HTMLElement 的 ref 不能赋给 div 元素)。ResizeObserver.observe 接受 Element,
  // HTMLDivElement 兼容。
  const contentRef = useRef<HTMLDivElement>(null);
  const contentResizeObserverRef = useRef<ResizeObserver | null>(null);
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

  // 事件回调引用恒定(useStableCallback),使 RunTimeline 的 memo 不被回调身份变化击穿;
  // 闭包始终是最新的,点击行为不受影响。plansByRun 一次性按 runId 分组(O(plans)),
  // 替代每个 run 一次 .filter(O(runs·plans));并让 plans prop 复用同一数组。
  const stableOpenFile = useStableCallback(onOpenFile);
  const stableOpenAgent = useStableCallback(onOpenAgent);
  const stableOpenPlan = useStableCallback(onOpenPlan);
  const stableOpenReview = useStableCallback(onOpenReview);
  const stableStopCommand = useStableCallback(onStopCommand);
  const plansByRun = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const plan of session?.plans ?? []) {
      const list = map.get(plan.runId);
      if (list) list.push(plan);
      else map.set(plan.runId, [plan]);
    }
    return map;
  }, [session?.plans]);
  const questionsByRun = useMemo(() => {
    const map = new Map<string, Question[]>();
    for (const question of session?.questions ?? []) {
      const list = map.get(question.runId);
      if (list) list.push(question);
      else map.set(question.runId, [question]);
    }
    return map;
  }, [session?.questions]);

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

  // 内容增长(session 变化)时,在 React commit 后、浏览器 paint 前同步把视口钉到底。
  // 根治 tool activity 等阶跃增长的「先 paint 在下方、200ms 后定时器才追上」跳动:
  // useLayoutEffect 在 DOM mutation 后、paint 前同步执行 → scrollTop 已贴底再 paint,
  // 新内容一出现就在它该在的贴底位置,没有「先下后上」。follow 门控(paused 时不滚)。
  // session 每事件新引用(本组件无 memo、App 每帧重渲)→ 每次内容增长都触发。
  useLayoutEffect(() => {
    if (modeRef.current !== "follow") return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session]);

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

  // 输入层预置 paused:向上滚轮(deltaY<0)立即 paused,不等 scroll 事件派生 —— 防 useLayoutEffect
  // 每帧钉底把用户上翻「弹回」(scroll 事件派发晚于 rAF 1-2 帧)。复刻 ReasoningTrace.tsx 的
  // pauseForUpwardScroll 模式。向下滚轮(deltaY>0,追最新)不 paused,follow 继续。
  const handleWheel = useCallback((event: React.WheelEvent<HTMLElement>) => {
    if (event.deltaY < 0) setMode("paused");
  }, [setMode]);

  // ResizeObserver:覆盖非 session 驱动的异步撑高(mermaid React.lazy 首渲 pre→异步换 SVG、
  // 字体/图片加载、InlinePlanCard max-height / operation-expander grid-rows 的 CSS 高度过渡、
  // composerBottomOffset spacer 变化)—— 这些 useLayoutEffect([session]) 抓不到,原本最多滞后
  // 200ms。RO 回调在 layout 后、paint 前触发,follow 时同步钉底赶上 paint。
  // 依赖 [sessionId, pendingRun.key]:切会话/切分支时 contentRef.current 换成新 .conversation-column
  // → 重建 RO;同会话内 sessionId 不变 → RO 持续 observe 同一节点(其高度变化,无论 session 驱动
  // 还是异步,都被捕获),无需每帧重建。复用上面蒙层 RO(useLayoutEffect)的模式。
  useEffect(() => {
    const content = contentRef.current;
    const scroll = scrollRef.current;
    if (!content || !scroll) return;
    const observer = new ResizeObserver(() => {
      if (modeRef.current !== "follow") return;
      scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(content);
    contentResizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      contentResizeObserverRef.current = null;
    };
  }, [session?.sessionId, pendingRun?.key]);

  // 对话区宽度跟随对话框实测宽度(第一性):column 与 composer 共享 CSS --stage-width,但 CSS
  // container query(100cqw)在嵌套/某些渲染路径下解析不稳(column 实测不随 composer 缩)。直接用
  // JS ResizeObserver 把 column 的 width 绑到 composer 的实测宽度 —— composer 任何状态(普通/inspector/
  // surface/窄屏)一变,column 立即同步,不依赖 CSS 公式/100cqw/margin 负值解析,数学上恒等。
  // 依赖 [sessionId, pendingRun.key]:切会话/分支 contentRef.current 换 → 重绑。
  useEffect(() => {
    const scroll = scrollRef.current;
    const main = scroll?.parentElement;
    const composer = main?.querySelector<HTMLElement>(".composer-stack");
    if (!scroll || !main || !composer) return;
    const sync = () => {
      const column = contentRef.current;
      if (!column) return;
      const width = composer.getBoundingClientRect().width;
      if (width > 0) column.style.width = `${width}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(composer);
    observer.observe(main);
    return () => observer.disconnect();
  }, [session?.sessionId, pendingRun?.key]);

  useEffect(() => {
    setMode("follow");
    requestAnimationFrame(scrollToBottom);
  }, [pendingRun?.key, session?.sessionId, setMode, scrollToBottom]);

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
      <div
        className="conversation-bottom-mask"
        style={{ height: `${composerBottomOffset}px` }}
        aria-hidden="true"
      />
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
      data-follow={!notAtBottom ? "true" : "false"}
      onScroll={handleScroll}
      onWheel={handleWheel}
      ref={scrollRef}
    >
      {pendingRun ? (
        <div className="conversation-column" ref={contentRef}>
          <div className="conversation-turn">
            <section className="user-turn"><p>{pendingRun.prompt}</p></section>
            <div className="run-stream">
              <button aria-live="polite" className="run-status-pill is-live is-expanded" disabled type="button">
                <span>{pendingRun.label}</span>
              </button>
            </div>
          </div>
          <div className="conversation-column-bottom-spacer" style={{ height: `${composerBottomOffset + 60}px` }} />
        </div>
      ) : session && session.runs.length > 0 ? (
        <div className="conversation-column" ref={contentRef}>
          {notices?.map((notice, index) => (
            <div className="conversation-notice" key={`notice-${index}`}>{notice}</div>
          ))}
          {session.runs.map((run) => (
            <RunTimeline
              key={run.runId}
              run={run}
              onOpenFile={stableOpenFile}
              onOpenAgent={stableOpenAgent}
              onOpenPlan={stableOpenPlan}
              onOpenReview={stableOpenReview}
              onStopCommand={stableStopCommand}
              plans={plansByRun.get(run.runId) ?? EMPTY_PLANS}
              questions={questionsByRun.get(run.runId) ?? EMPTY_QUESTIONS}
            />
          ))}
          <div className="conversation-column-bottom-spacer" style={{ height: `${composerBottomOffset + 60}px` }} />
        </div>
      ) : (
        <div className="conversation-empty-state"><h1>让我们一起深度创造</h1></div>
      )}
      {overlays}
      {scrollButton}
    </section>
  );
}
