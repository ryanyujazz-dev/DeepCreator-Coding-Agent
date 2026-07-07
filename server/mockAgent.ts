import { collectDiffSummary, executeRuntimeTool } from "./tools";
import { RunStore } from "./eventStore";

const DEFAULT_MOCK_STEP_DELAY_MS = 600;
const LONG_MOCK_STEP_DELAY_MS = 10000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("运行已取消。", "AbortError");
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

export async function runMockAgent(input: {
  projectRoot: string;
  prompt: string;
  runId: string;
  signal?: AbortSignal;
  store: RunStore;
}): Promise<void> {
  const { projectRoot, prompt, runId, signal, store } = input;
  const stepDelay = /cancel|slow|停止|取消/i.test(prompt)
    ? LONG_MOCK_STEP_DELAY_MS
    : DEFAULT_MOCK_STEP_DELAY_MS;

  throwIfAborted(signal);
  store.updateHUD(runId, {
    currentStep: 1,
    currentStepTitle: "理解任务",
    status: "thinking",
    totalSteps: 3
  });
  store.addEvent(runId, {
    body: "离线 mock agent 正在模拟 DeepSeek reasoning/content/tool_calls 流程。",
    meta: { tokenSource: "reasoning_content" },
    status: "completed",
    title: "模型思考摘要",
    type: "model.reasoning.delta"
  });
  store.updateTask(runId, {
    agentStatus: "in_progress",
    id: "task_inspect",
    title: "检查项目结构",
    verification: {
      kind: "command_exit_zero",
      commandPattern: "git status"
    }
  });

  await wait(stepDelay, signal);
  throwIfAborted(signal);
  store.updateHUD(runId, {
    currentStep: 2,
    currentStepTitle: "检查 Git 状态",
    status: "running_tool"
  });
  store.addEvent(runId, {
    body: "git_status",
    meta: { tokenSource: "tool_calls", toolName: "git_status" },
    status: "running",
    title: "检查 Git 状态中",
    type: "tool.execution.started"
  });

  const gitStatus = await executeRuntimeTool(projectRoot, "git_status", {});
  throwIfAborted(signal);
  const evidence = store.addEvidence(runId, {
    detail: gitStatus.slice(0, 500),
    kind: "git",
    status: "completed",
    title: "Git 状态"
  });
  store.addEvent(runId, {
    body: gitStatus.slice(0, 1200),
    meta: { tokenSource: "tool_calls", toolName: "git_status" },
    status: "completed",
    title: "Git 状态检查完成",
    type: "tool.execution.completed"
  });

  const diffSummary = await collectDiffSummary(projectRoot);
  store.updateDiff(runId, diffSummary);
  store.updateTask(runId, {
    agentStatus: "claimed_done",
    evidenceRef: evidence?.id,
    id: "task_inspect",
    runtimeStatus: "verified",
    title: "检查项目结构"
  });

  await wait(stepDelay, signal);
  throwIfAborted(signal);
  store.updateTask(runId, {
    agentStatus: "in_progress",
    id: "task_report",
    title: "生成运行摘要"
  });
  store.updateHUD(runId, {
    currentStep: 3,
    currentStepTitle: "生成运行摘要",
    status: "thinking"
  });
  store.addEvent(runId, {
    body: `收到请求：${prompt}`,
    meta: { tokenSource: "content" },
    status: "completed",
    title: "模型生成回复",
    type: "model.content.delta"
  });
  store.updateTask(runId, {
    agentStatus: "claimed_done",
    id: "task_report",
    runtimeStatus: "verified",
    title: "生成运行摘要"
  });

  store.completeRun(
    runId,
    [
      "Mock Agent Runtime 已完成一次离线端到端运行。",
      `本次请求是：${prompt}`,
      `当前工作区检测到 ${diffSummary.changedFiles} 个文件变化，+${diffSummary.additions} -${diffSummary.deletions}。`
    ].join("\n\n")
  );
}
