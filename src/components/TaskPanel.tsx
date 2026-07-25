import { CheckCircle2, Circle, LoaderCircle, OctagonX } from "lucide-react";
import { Task } from "../../shared/contracts/runtime";

export function TaskPanel({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <p className="task-list-empty">Agent 尚未建立执行任务</p>;
  return <div className="task-list">{tasks.map((task) => (
    <div className={`task-list-row is-${task.status}`} key={task.taskId}>
      {task.status === "completed" ? <CheckCircle2 size={13} /> : task.status === "running" ? <LoaderCircle size={13} /> : task.status === "blocked" ? <OctagonX size={13} /> : <Circle size={13} />}
      <span>{task.label}</span>
    </div>
  ))}</div>;
}
