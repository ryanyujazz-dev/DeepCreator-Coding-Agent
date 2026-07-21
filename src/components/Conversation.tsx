import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Changes, Session } from "../../shared/contracts/runtime";
import { RunTimeline } from "./RunTimeline";

// === 滚动跟随状态机(第一性设计)===
//
// 核心思路:不依赖任何业务信号(lastOffset / onTextFrame / runCount),
// 用一个 200ms 定时器在 "follow" 模式下持续把 scrollTop 钉在 scrollHeight。
// 模式切换完全靠 onScroll 里的纯位置判断 + 滞后阈值。
//
// 状态:
//   follow  - 定时器每 200ms 把 scrollTop 设到 scrollHeight
//   paused  - 定时器什么都不做,用户自由翻历史
//
// 转换(在 onScroll 里,纯位置判断):
//   follow + distance > PAUSE_THRESHOLD  → paused(用户明显向上滚)
//   paused + distance < RESUME_THRESHOLD → follow(用户滚回底部)
//   中间区间                              → 保持现状(过滤内容增长抖动)
//
// 为什么纯位置能工作:
//   - 程序跟随期间 distance ≈ 0,永远 stay follow
//   - 用户向上滚 → distance 变大 → 转 paused
//   - 用户滚回底部 → distance < 8 → 转 follow
//   - 内容增长瞬时滞后(几十像素)→ 在滞后区间内,不触发转换

const RESUME_THRESHOLD = 8;   // 距底部 ≤ 8px:恢复跟随
const PAUSE_THRESHOLD = 60;   // 距底部 > 60px(且当前 follow):暂停跟随
const POLL_INTERVAL_MS = 200; // follow 模式下的轮询间隔

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
  const [showScrollButton, setShowScrollButton] = useState(false);

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
    setShowScrollButton(next === "paused");
  }, []);

  // 定时轮询:follow 模式下每 200ms 把 scrollTop 钉到底部
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (modeRef.current !== "follow") return;
      scrollToBottom();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [scrollToBottom]);

  // onScroll:纯位置判断决定模式切换
  const handleScroll = useCallback((event: React.BaseSyntheticEvent) => {
    const el = event.currentTarget as HTMLElement;
    const distance = distanceFromBottom(el);
    if (modeRef.current === "follow") {
      // 跟随中:只有明显远离底部(> 60px)才暂停,容忍内容增长抖动
      if (distance > PAUSE_THRESHOLD) setMode("paused");
    } else {
      // 暂停中:只有非常接近底部(< 8px)才恢复跟随
      if (distance < RESUME_THRESHOLD) setMode("follow");
    }
  }, [distanceFromBottom, setMode]);

  // 切换 session:强制 follow(新会话从头看到底)
  useEffect(() => {
    setMode("follow");
    // 切换后立即滚到底(不等下一个 200ms tick)
    requestAnimationFrame(scrollToBottom);
  }, [session?.sessionId, setMode, scrollToBottom]);

  // 新 run 开始(用户发了新消息):强制 follow(用户显然想看新输出)
  const runCount = session?.runs.length ?? 0;
  const prevRunCountRef = useRef(runCount);
  useEffect(() => {
    if (runCount > prevRunCountRef.current) {
      setMode("follow");
      // 新 run 的 DOM 可能要一两帧才渲染出来,延两帧再滚
      requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    }
    prevRunCountRef.current = runCount;
  }, [runCount, setMode, scrollToBottom]);

  // 用户点"滚动到底部"按钮
  const handleScrollToBottomClick = useCallback(() => {
    setMode("follow");
    scrollToBottom();
  }, [setMode, scrollToBottom]);

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
        </div>
      ) : (
        <div className="conversation-empty-state"><h1>我们该构建什么？</h1></div>
      )}
      {showScrollButton && (
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
