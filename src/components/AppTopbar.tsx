import { useEffect, useState } from "react";
import { desktopBridge } from "../platform/desktop";

export function AppTopbar() {
  const desktop = desktopBridge();
  const platform = desktop?.platform ?? "web";
  const [trafficLightsVisible, setTrafficLightsVisible] = useState(platform === "darwin");

  useEffect(() => {
    if (platform !== "darwin" || !desktop) return;
    let active = true;
    const unsubscribe = desktop.windowControls.onState((state) => {
      if (active) setTrafficLightsVisible(state.trafficLightsVisible);
    });
    void desktop.windowControls.getState().then((state) => {
      if (active) setTrafficLightsVisible(state.trafficLightsVisible);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop, platform]);

  return (
    <header
      className="app-menubar"
      data-platform={platform}
      data-window-controls={trafficLightsVisible ? "visible" : "hidden"}
    >
      <nav aria-label="应用菜单" className="app-menu-items">
        <span>文件</span>
        <span>编辑</span>
        <span>视图</span>
        <span>帮助</span>
      </nav>
      <div aria-hidden="true" className="app-menubar-drag-region" />
    </header>
  );
}
