import { ChevronDown, ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Task } from "../../shared/contracts/runtime";
import { TaskPanel } from "./TaskPanel";

export function TaskProgress({
  active,
  label,
  tasks
}: {
  active: boolean;
  label: string;
  tasks: Task[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const expandable = tasks.length > 0;
  const completed = tasks.filter((task) => task.status === "completed").length;

  useEffect(() => {
    if (!active || !expandable) setOpen(false);
  }, [active, expandable]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="task-progress" ref={rootRef}>
      <button
        aria-expanded={expandable ? open : undefined}
        className="composer-hud-primary"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>{active ? "正在执行" : "等待决定"}</span>
        <strong>{label}</strong>
        {expandable && <ChevronDown className="task-progress-chevron" size={14} />}
      </button>
      {open && (
        <section className="task-progress-popover" aria-label="执行计划">
          <header>
            <span><ListChecks size={14} />执行计划</span>
            <small>{completed}/{tasks.length}</small>
          </header>
          <TaskPanel current={tasks} history={[]} />
        </section>
      )}
    </div>
  );
}
