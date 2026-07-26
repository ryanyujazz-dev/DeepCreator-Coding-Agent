import { DesktopBridge } from "../../shared/contracts/desktop";

/** Single renderer boundary for optional Electron preload capabilities. */
export function desktopBridge(): DesktopBridge | undefined {
  return window.deepseeker;
}
