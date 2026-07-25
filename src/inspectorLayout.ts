import { RefObject, useLayoutEffect, useRef, useState } from "react";

export type InspectorLayout = "centered" | "reserved" | "compact";

export const INSPECTOR_LAYOUT = {
  collisionGap: 28,
  conversationGutter: 38,
  conversationMax: 860,
  conversationMin: 640,
  hysteresis: 24,
  panelRight: 17,
  panelWidth: 360
} as const;

export const SIDEBAR_LAYOUT = {
  conversationStageMin: 680,
  hysteresis: 24
} as const;

function centeredBoundary(): number {
  const { collisionGap, conversationMax, panelRight, panelWidth } = INSPECTOR_LAYOUT;
  return 2 * (panelRight + panelWidth + collisionGap + conversationMax / 2);
}

function compactBoundary(): number {
  const {
    collisionGap,
    conversationGutter,
    conversationMin,
    panelRight,
    panelWidth
  } = INSPECTOR_LAYOUT;
  return panelRight + panelWidth + collisionGap + conversationGutter + conversationMin;
}

export function resolveInspectorLayout(
  width: number,
  previous: InspectorLayout = "centered"
): InspectorLayout {
  const centeredAt = centeredBoundary();
  const compactAt = compactBoundary();
  const { hysteresis } = INSPECTOR_LAYOUT;

  if (previous === "centered" && width >= centeredAt - hysteresis) return "centered";
  if (previous !== "centered" && width >= centeredAt + hysteresis) return "centered";
  if (previous === "compact" && width <= compactAt + hysteresis) return "compact";
  if (previous !== "compact" && width <= compactAt - hysteresis) return "compact";
  return "reserved";
}

export function resolveCompactSidebar(
  viewportWidth: number,
  sidebarWidth: number,
  previous = false
): boolean {
  const boundary = sidebarWidth + SIDEBAR_LAYOUT.conversationStageMin;
  return previous
    ? viewportWidth <= boundary + SIDEBAR_LAYOUT.hysteresis
    : viewportWidth <= boundary - SIDEBAR_LAYOUT.hysteresis;
}

export function useInspectorLayout(): {
  layout: InspectorLayout;
  targetRef: RefObject<HTMLDivElement>;
} {
  const targetRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<InspectorLayout>("centered");

  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const update = () => {
      setLayout((previous) => resolveInspectorLayout(target.clientWidth, previous));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return { layout, targetRef };
}
