import { useEffect, useState } from "react";
import { type Task, type Session, isRunDone } from "../../../shared/contracts/runtime";
import { browserPlatform } from "../../platform/browser";

const MAX_HISTORY = 5;

export type TaskBatch = {
  runId: string;
  capturedAt: number;
  tasks: Task[];
};

function isValidBatch(value: unknown): value is TaskBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Record<string, unknown>;
  return typeof batch.runId === "string"
    && typeof batch.capturedAt === "number"
    && Array.isArray(batch.tasks);
}

// 按 projectRoot 分隔存储 key:同项目的不同会话共享同一份任务历史(跨会话累积),不同项目互相隔离。
function storageKey(projectRoot: string): string {
  return `deepcreator.taskBatches.${projectRoot}`;
}

// 经 browserPlatform.storage 路由(架构规则要求 renderer 通过平台边界访问存储,
// 不得在 platform/ 之外直接触碰宿主存储 API),与 sidebarWidth / surfaceWidth 等持久化一致。
function readStored(projectRoot: string): TaskBatch[] {
  try {
    const raw = browserPlatform.storage.get(storageKey(projectRoot));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidBatch);
  } catch {
    return [];
  }
}

function writeStored(projectRoot: string, batches: TaskBatch[]): void {
  try {
    browserPlatform.storage.set(storageKey(projectRoot), JSON.stringify(batches));
  } catch {
    // storage 可能不可用(隐私模式 / 超额),静默失败即可。
  }
}

/**
 * 客户端任务历史累积:把每个「已完成且非最新」的 run 的任务快照存进 storage,
 * newest-first 保留最近 5 个(滚动窗口),跨刷新 / 跨会话保留。
 *
 * 存储 key 按 projectRoot 分隔 → 同项目的不同 session 共享同一份历史(跨会话互相可见)。
 *
 * 最新 run 的 tasks 永远作为「当前批」实时返回(不入库),所以当新 run 启动时,
 * 上一 done run 会在下一次调和时自动落入历史。session=null(刷新落地「新任务」页)时
 * current 为空、history 仍来自 storage —— 即用户要的「刷新后仍可见」。
 */
export function useTaskHistory(session: Session | null): { current: Task[]; history: TaskBatch[] } {
  const projectRoot = session?.projectRoot;
  const [history, setHistory] = useState<TaskBatch[]>(() => (projectRoot ? readStored(projectRoot) : []));

  const current: Task[] = session?.runs.at(-1)?.tasks ?? [];

  useEffect(() => {
    if (!session || !projectRoot) return;
    // 切项目时重读该项目的历史(不同 projectRoot 不同 key)。
    setHistory(readStored(projectRoot));
    const runs = session.runs;
    const latestRunId = runs.at(-1)?.runId;
    // 已完成、有任务、且不是最新 run(最新 run 是「当前批」,避免当前与历史重复)
    const doneRuns = runs.filter(
      (run) => isRunDone(run.status) && run.tasks.length > 0 && run.runId !== latestRunId
    );
    if (doneRuns.length === 0) return;

    setHistory((prev) => {
      const seen = new Set(prev.map((batch) => batch.runId));
      const capturedAt = Date.now();
      // doneRuns 按 session 顺序(旧→新);反向遍历让 newest 排在 fresh 头部
      const fresh: TaskBatch[] = [];
      for (let index = doneRuns.length - 1; index >= 0; index -= 1) {
        const run = doneRuns[index];
        if (seen.has(run.runId)) continue;
        seen.add(run.runId);
        fresh.push({ runId: run.runId, capturedAt, tasks: run.tasks });
      }
      if (fresh.length === 0) return prev;
      const merged = [...fresh, ...prev].slice(0, MAX_HISTORY);
      writeStored(projectRoot, merged);
      return merged;
    });
  }, [session, projectRoot]);

  return { current, history };
}
