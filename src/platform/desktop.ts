import { DesktopBridge } from "../../shared/contracts/desktop";

/** Single renderer boundary for optional Electron preload capabilities. */
export function desktopBridge(): DesktopBridge | undefined {
  return window.deepcreator;
}

export function desktopErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
