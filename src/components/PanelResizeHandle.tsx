import { KeyboardEvent, PointerEvent, useEffect, useRef } from "react";

function resolveLimit(limit: number | (() => number)): number {
  return typeof limit === "function" ? limit() : limit;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function PanelResizeHandle({
  ariaLabel,
  edge,
  max,
  min,
  onChange,
  onReset,
  value
}: {
  ariaLabel: string;
  edge: "left" | "right";
  max: number | (() => number);
  min: number;
  onChange: (value: number) => void;
  onReset: () => void;
  value: number;
}) {
  const drag = useRef<{ pointerId: number; startValue: number; startX: number } | null>(null);
  const direction = edge === "right" ? 1 : -1;
  const stopDragging = () => {
    drag.current = null;
    document.body.classList.remove("is-resizing-panel");
  };

  useEffect(() => stopDragging, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const maximum = resolveLimit(max);
    if (event.key === "Home") return onChange(min);
    if (event.key === "End") return onChange(maximum);
    const screenDelta = event.key === "ArrowRight" ? 8 : -8;
    onChange(clamp(value + screenDelta * direction, min, maximum));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startValue: value, startX: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-panel");
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const next = drag.current.startValue + (event.clientX - drag.current.startX) * direction;
    onChange(clamp(next, min, resolveLimit(max)));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    stopDragging();
  };

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={resolveLimit(max)}
      aria-valuemin={min}
      aria-valuenow={Math.round(value)}
      className={`panel-resize-handle is-${edge}`}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
    />
  );
}
