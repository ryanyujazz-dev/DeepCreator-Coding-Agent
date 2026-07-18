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

  return frame;
}
