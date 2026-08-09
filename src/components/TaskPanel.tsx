import { CheckCircle2, Circle, LoaderCircle, OctagonX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/contracts/runtime";
import type { TaskBatch } from "../features/runtime/useTaskHistory";

const MIN_HEIGHT = 88;
const MAX_HEIGHT = 300;
const MASK_THRESHOLD_PX = 2;

function TaskListRow({ label, status }: { label: string; status: Task["status"] }) {
  return (
    <div className={`task-list-row is-${status}`}>
      {status === "completed" ? <CheckCircle2 size={13} /> : status === "running" ? <LoaderCircle size={13} /> : status === "blocked" ? <OctagonX size={13} /> : <Circle size={13} />}
      <span>{label}</span>
    </div>
  );
}

function TaskRows({ tasks }: { tasks: Task[] }) {
  return (
    <>
      {tasks.map((task) => (
        <TaskListRow key={task.taskId} label={task.label} status={task.status} />
      ))}
    </>
  );
}

/**
 * 任务面板:当前批(已完成的 task 下沉到当前批底部)在最上方,历史批次(最近 5 个 run
 * 的快照)在下方,需滚动才可见。视口默认只显示当前批(动态 max-height = 当前批高度),
 * 内容超出时底部出现渐变蒙层,提示下方还有历史。
 */
export function TaskPanel({ current, history }: { current: Task[]; history: TaskBatch[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const [currentHeight, setCurrentHeight] = useState<number | null>(null);
  const [notAtBottom, setNotAtBottom] = useState(false);

  // 当前批内部排序:已完成下沉(JS Array.filter 保序,组内原次不变)
  const ordered = [
    ...current.filter((task) => task.status !== "completed"),
    ...current.filter((task) => task.status === "completed")
  ];

  // 动态 max-height = 当前批高度(钳位),让视口默认只显示当前批;无当前批时给最大值便于滚历史
  const clampHeight = current.length > 0 && currentHeight !== null
    ? Math.min(Math.max(currentHeight, MIN_HEIGHT), MAX_HEIGHT)
    : MAX_HEIGHT;

  // 测量当前批高度:ResizeObserver 持续跟踪(任务增减 / 文本换行时自适应)
  const hasCurrent = current.length > 0;
  useEffect(() => {
    const node = currentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setCurrentHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasCurrent]);

  // 蒙层显隐:溢出且未滚到底 → 显示
  const recomputeMask = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setNotAtBottom(distanceFromBottom > MASK_THRESHOLD_PX);
  }, []);

  const handleScroll = useCallback(() => {
    recomputeMask();
  }, [recomputeMask]);

  useEffect(() => {
    recomputeMask();
  }, [recomputeMask, clampHeight, current.length, history.length]);

  if (current.length === 0 && history.length === 0) {
    return (
      <div className="environment-row is-muted">
        <Circle size={15} />
        <span>Agent 尚未建立执行任务</span>
      </div>
    );
  }

  return (
    <div className="task-history-shell">
      <div
        className="task-history-scroll"
        onScroll={handleScroll}
        ref={scrollRef}
        style={{ maxHeight: clampHeight }}
      >
        {hasCurrent && (
          <div className="task-batch task-batch-current" ref={currentRef}>
            <TaskRows tasks={ordered} />
          </div>
        )}
        {history.map((batch) => (
          <div className="task-batch task-batch-past" key={batch.runId}>
            <div className="task-batch-separator" aria-hidden />
            <TaskRows tasks={batch.tasks} />
          </div>
        ))}
      </div>
      {notAtBottom && <div className="task-history-mask" aria-hidden />}
    </div>
  );
}
