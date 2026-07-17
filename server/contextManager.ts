import { CycleView, RecoveryCapsule, WorkspaceSessionView } from "../shared/runtimeTypes";

export type PreparedContext = {
  compacted: boolean;
  compactedCycleCount: number;
  contextTokenEstimate: number;
  keptCycles: CycleView[];
  recovery?: RecoveryCapsule;
  summary?: string;
  thresholdTokens: number;
  windowTokens: number;
};

const DEFAULT_WINDOW = 1_000_000;
const DEFAULT_RATIO = 0.85;
const DEFAULT_KEEP_RECENT = 6;
const MAX_SUMMARY_CHARS = 40_000;

export function getContextWindowTokens(): number {
  return Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? DEFAULT_WINDOW);
}

export function getCompactThresholdTokens(): number {
  return Math.floor(
    getContextWindowTokens() * Number(process.env.DEEPSEEK_COMPACT_TRIGGER_RATIO ?? DEFAULT_RATIO)
  );
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) character.charCodeAt(0) <= 0x7f ? (ascii += 1) : (nonAscii += 1);
  return Math.ceil(ascii / 4 + nonAscii * 0.8);
}

function cycleText(cycle: CycleView): string {
  return `用户：${cycle.prompt}\n助手：${cycle.finalResponse || cycle.failure || "（本轮未完成）"}`;
}

function estimate(summary: string | undefined, cycles: CycleView[], prompt: string): number {
  return estimateTokens([summary ? `历史摘要：${summary}` : "", ...cycles.map(cycleText), `用户：${prompt}`].filter(Boolean).join("\n\n"));
}

function wantsRecovery(prompt: string): boolean {
  return /^(?:请)?(?:继续|接着|重试|恢复|继续工作|接着做|继续做)(?:\s|[，,。.!！]|$)/i.test(prompt.trim());
}

function compactText(previous: string | undefined, cycles: CycleView[]): string {
  const text = [
    "早期会话摘要：",
    previous ?? "",
    cycles.map(cycleText).join("\n\n")
  ].filter(Boolean).join("\n\n");
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const head = Math.floor(MAX_SUMMARY_CHARS * 0.65);
  return `${text.slice(0, head)}\n\n[较早内容已压缩]\n\n${text.slice(-(MAX_SUMMARY_CHARS - head))}`;
}

export function prepareSessionContext(session: WorkspaceSessionView, currentCycleKey: string, prompt: string): PreparedContext {
  const previousCycles = session.cycles.filter((cycle) => cycle.cycleKey !== currentCycleKey);
  const cycles = previousCycles.filter((cycle) => cycle.phase === "succeeded");
  const recovery = wantsRecovery(prompt) ? [...previousCycles].reverse().find((cycle) => cycle.recovery)?.recovery : undefined;
  const windowTokens = session.contextWindowTokens || getContextWindowTokens();
  const thresholdTokens = session.compactThresholdTokens || getCompactThresholdTokens();
  const contextTokenEstimate = Math.max(
    estimate(session.compactSummary, cycles, prompt),
    session.contextTokenEstimate
  );
  if (contextTokenEstimate < thresholdTokens) {
    return { compacted: false, compactedCycleCount: 0, contextTokenEstimate, keptCycles: cycles, recovery, summary: session.compactSummary, thresholdTokens, windowTokens };
  }
  const keepCount = Math.max(1, Number(process.env.DEEPSEEK_COMPACT_KEEP_RECENT_CYCLES ?? DEFAULT_KEEP_RECENT));
  const split = Math.max(0, cycles.length - keepCount);
  if (split === 0) {
    return { compacted: false, compactedCycleCount: 0, contextTokenEstimate, keptCycles: cycles, recovery, summary: session.compactSummary, thresholdTokens, windowTokens };
  }
  const summary = compactText(session.compactSummary, cycles.slice(0, split));
  const keptCycles = cycles.slice(split);
  return {
    compacted: true,
    compactedCycleCount: split,
    contextTokenEstimate: estimate(summary, keptCycles, prompt),
    keptCycles,
    recovery,
    summary,
    thresholdTokens,
    windowTokens
  };
}
