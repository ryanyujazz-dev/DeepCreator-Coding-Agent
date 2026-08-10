import { useCallback, useEffect, useRef, useState } from "react";
import {
  STREAM_FRAME_BUDGET_MS,
  StreamFrame,
  advanceStreamFrame,
  splitGraphemes,
  streamFrameQuota,
  streamReleaseInterval
} from "./textFlow";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useStreamText(text: string, streaming: boolean, onFrame?: () => void): StreamFrame {
  const [frame, setFrame] = useState<StreamFrame>(() => ({ fragments: [], stable: text }));
  const frameRef = useRef(frame);
  const canonicalRef = useRef(text);
  const pendingRef = useRef<string[]>([]);
  const pendingIndexRef = useRef(0);
  const fragmentIdRef = useRef(0);
  const lastReleaseAtRef = useRef(0);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const commit = useCallback((next: StreamFrame) => {
    frameRef.current = next;
    setFrame(next);
    onFrameRef.current?.();
  }, []);

  const flush = useCallback((value: string) => {
    if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = undefined;
    pendingRef.current = [];
    pendingIndexRef.current = 0;
    lastReleaseAtRef.current = 0;
    commit({ fragments: [], stable: value });
  }, [commit]);

  const scheduleRef = useRef<() => void>(() => undefined);
  const tick = useCallback((frameTime: number) => {
    animationFrameRef.current = undefined;
    const pending = pendingRef.current;
    const startIndex = pendingIndexRef.current;
    const pendingCount = pending.length - startIndex;
    const releaseInterval = streamReleaseInterval(pendingCount);
    const canRelease = pendingCount > 0 && (
      lastReleaseAtRef.current === 0 || frameTime - lastReleaseAtRef.current >= releaseInterval
    );
    const quota = canRelease ? streamFrameQuota(pendingCount) : 0;
    const startedAt = performance.now();
    let cursor = startIndex;

    while (
      cursor < pending.length &&
      cursor - startIndex < quota &&
      performance.now() - startedAt < STREAM_FRAME_BUDGET_MS
    ) {
      cursor += 1;
    }

    const releasedText = pending.slice(startIndex, cursor).join("");
    if (releasedText) lastReleaseAtRef.current = frameTime;
    pendingIndexRef.current = cursor;
    if (cursor === pending.length) {
      pendingRef.current = [];
      pendingIndexRef.current = 0;
    } else if (cursor > 512) {
      pendingRef.current = pending.slice(cursor);
      pendingIndexRef.current = 0;
    }

    const shouldAdvance = Boolean(releasedText) || frameRef.current.fragments.length > 0;
    const next = shouldAdvance
      ? advanceStreamFrame(frameRef.current, releasedText, ++fragmentIdRef.current)
      : frameRef.current;
    if (shouldAdvance) commit(next);
    if (pendingRef.current.length > pendingIndexRef.current || next.fragments.length > 0) scheduleRef.current();
  }, [commit]);

  const schedule = useCallback(() => {
    if (animationFrameRef.current === undefined) animationFrameRef.current = requestAnimationFrame(tick);
  }, [tick]);
  scheduleRef.current = schedule;

  useEffect(() => {
    const previous = canonicalRef.current;
    canonicalRef.current = text;

    if (!streaming || prefersReducedMotion() || !text.startsWith(previous)) {
      flush(text);
      return;
    }

    const delta = text.slice(previous.length);
    if (!delta) return;
    pendingRef.current.push(...splitGraphemes(delta));
    schedule();
  }, [flush, schedule, streaming, text]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleMotionChange = () => {
      if (media.matches) flush(canonicalRef.current);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) flush(canonicalRef.current);
    };
    media.addEventListener("change", handleMotionChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      media.removeEventListener("change", handleMotionChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [flush]);

  // 渲染体同步派生可见 frame —— 凡「应立即显示全文」的情形(与下方 effect 的 flush 判定一致),
  // 该次渲染本身就返回全文,不再回旧的 useState frame、不再等 commit+paint 之后的被动 effect 去 setFrame。
  // 根治:message activity.finished 到达使 streaming 翻 false 后,原 flush 写在被动 useEffect 里,其执行
  // 在工具执行期间被连续的工具事件渲染(每 chunk→applyEvents→rAF emit→React 重渲)当成低优先级
  // macrotask 反复延后,直到工具结束才跑 → content「先两个字,工具完成后才一口气出全文」。
  // 让可见输出在 streaming/文本变化的同一 commit 落定,即对被动 effect 调度抢占完全免疫。
  // 原有两个 useEffect 保留:负责清 rAF/pending 与 frame state 最终一致(reduced-motion / visibility /
  // 极少 false→true 复用),但其执行时机不再决定可见输出。此处只读 canonicalRef(反映上次 commit 的
  // 全文),与 effect 中的写入配合,保证 startsWith 增量判定在渲染体与 effect 间一致。
  const visiblePrevious = canonicalRef.current;
  if (!streaming || prefersReducedMotion() || !text.startsWith(visiblePrevious)) {
    return { fragments: [], stable: text };
  }
  return frame;
}
