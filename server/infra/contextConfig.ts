import { platform } from "node:os";
import { ContextConfig, defaultContextConfig } from "../app/contextBuilder";
import { resolveRuntimeShell } from "./shell";

function number(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function contextConfig(): ContextConfig {
  return {
    compactRatio: number("DEEPSEEK_COMPACT_TRIGGER_RATIO", defaultContextConfig.compactRatio),
    maxOutputTokens: number("DEEPSEEK_MAX_OUTPUT_TOKENS", defaultContextConfig.maxOutputTokens),
    maxSummaryChars: number("DEEPSEEK_COMPACTION_SUMMARY_MAX_CHARS", defaultContextConfig.maxSummaryChars),
    platform: platform(),
    protocolReserveTokens: number("DEEPSEEK_PROTOCOL_RESERVE_TOKENS", defaultContextConfig.protocolReserveTokens),
    safetyMarginTokens: number("DEEPSEEK_CONTEXT_SAFETY_TOKENS", defaultContextConfig.safetyMarginTokens),
    shellFamily: resolveRuntimeShell().family,
    windowTokens: number("DEEPSEEK_CONTEXT_WINDOW_TOKENS", defaultContextConfig.windowTokens)
  };
}
