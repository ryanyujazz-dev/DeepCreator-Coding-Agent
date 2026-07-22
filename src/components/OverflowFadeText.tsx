import { ReactNode, useLayoutEffect, useRef, useState } from "react";

export function OverflowFadeText({ children }: { children: ReactNode }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span className={`sidebar-item-label${overflowing ? " is-overflowing" : ""}`} ref={elementRef}>
      {children}
    </span>
  );
}
