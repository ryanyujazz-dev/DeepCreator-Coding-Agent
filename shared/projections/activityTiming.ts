import { Activity } from "../contracts/runtime";

export const COMMAND_TIMER_REVEAL_AFTER_SECONDS = 24;

export function formatActivityElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export function runningCommandElapsed(
  activity: Activity | undefined,
  now = Date.now()
): string | undefined {
  if (activity?.status !== "running" || activity.tool?.toolName !== "run_command") return undefined;
  const startedAt = Date.parse(activity.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;

  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  if (elapsedSeconds <= COMMAND_TIMER_REVEAL_AFTER_SECONDS) return undefined;
  return formatActivityElapsed(elapsedSeconds);
}
