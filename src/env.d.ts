import { DesktopBridge } from "../shared/contracts/desktop";

declare global {
  interface Window {
    deepseeker?: DesktopBridge;
  }
}

export {};
