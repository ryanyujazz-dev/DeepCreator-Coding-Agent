export const STREAM_FADE_FRAMES = 5;
export const STREAM_FRAME_BUDGET_MS = 4;

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
  return Math.min(64, Math.max(2, Math.ceil(pendingCount / 8)));
}

export function streamReleaseInterval(pendingCount: number): number {
  if (pendingCount <= 16) return 24;
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
