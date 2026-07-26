export const SCROLL_FOLLOW_RESUME_THRESHOLD = 8;
export const SCROLL_FOLLOW_PAUSE_THRESHOLD = 60;
export const SCROLL_FOLLOW_EDGE_THRESHOLD = 8;

export type ScrollFollowMode = "follow" | "paused";

export function resolveScrollFollowMode(mode: ScrollFollowMode, distanceFromBottom: number): ScrollFollowMode {
  if (mode === "follow" && distanceFromBottom > SCROLL_FOLLOW_PAUSE_THRESHOLD) return "paused";
  if (mode === "paused" && distanceFromBottom < SCROLL_FOLLOW_RESUME_THRESHOLD) return "follow";
  return mode;
}
