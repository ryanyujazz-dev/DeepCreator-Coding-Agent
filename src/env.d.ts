import { DesktopBridge } from "../shared/contracts/desktop";

declare global {
  interface Window {
    deepcreator?: DesktopBridge;
  }
}

export {};
