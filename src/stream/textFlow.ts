export const STREAM_FADE_FRAMES = 5;
export const STREAM_FRAME_BUDGET_MS = 4;

// 尾端阈值:pending grapheme 数 ≤ 此值时视为「content 收尾 / 到达稀疏」,走即时一次清空
// (interval 0 + quota = pendingCount),避免最后几个字按节流节奏蹦着「卡」。中段/突发(> 此值)
// 仍节流匀速(16ms + ceil(n/8) 配额),保留打字机平滑、防一次性刷屏。
export const STREAM_TAIL_GRAPHMES = 16;

export type StreamFragment = {
  frame: number;
  id: number;
  text: string;
};

export type StreamFrame = {
  fragments: StreamFragment[];
  stable: string;
};

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  return segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);
}

export function streamFrameQuota(pendingCount: number): number {
  // 尾端一次清空:content 最后几个字不等节流,立即放出,杜绝收尾卡顿。
  if (pendingCount <= STREAM_TAIL_GRAPHMES) return pendingCount;
  return Math.min(64, Math.max(2, Math.ceil(pendingCount / 8)));
}

export function streamReleaseInterval(pendingCount: number): number {
  // 尾端即时:pending 少(content 收尾 / 到达稀疏)每帧释放,不被 24ms 节奏拖住 —— 根治「最后几个字卡一下」。
  if (pendingCount <= STREAM_TAIL_GRAPHMES) return 0;
  if (pendingCount <= 96) return 16;
  return 0;
}

export function fragmentOpacity(frame: number): number {
  return Math.min(1, Math.max(0, frame / STREAM_FADE_FRAMES));
}

export function advanceStreamFrame(
  current: StreamFrame,
  releasedText: string,
  fragmentId: number
): StreamFrame {
  let stable = current.stable;
  const fragments: StreamFragment[] = [];

  for (const fragment of current.fragments) {
    if (fragment.frame >= STREAM_FADE_FRAMES) {
      stable += fragment.text;
    } else {
      fragments.push({ ...fragment, frame: fragment.frame + 1 });
    }
  }

  if (releasedText) {
    fragments.push({ frame: 1, id: fragmentId, text: releasedText });
  }

  return { fragments, stable };
}
