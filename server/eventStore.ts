import {
  AgentEvent,
  AgentEventStatus,
  AgentEventType,
  AgentRun,
  createInitialHUD,
  deriveDisplayStatus,
  DiffSummary,
  emptyDiffSummary,
  Evidence,
  VerificationRule
} from "../shared/agentTypes";

type Subscriber = (run: AgentRun) => void;

function nowLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
}

function elapsedLabel(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "0s";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function cloneRun(run: AgentRun): AgentRun {
  return JSON.parse(JSON.stringify(run)) as AgentRun;
}

export class RunStore {
  private runs = new Map<string, AgentRun>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private sequence = new Map<string, number>();

  createRun(input: { id: string; model: string; projectRoot: string; prompt: string }): AgentRun {
    const startedAt = new Date().toISOString();
    const run: AgentRun = {
      artifacts: [],
      completedAt: undefined,
      diffSummary: emptyDiffSummary(),
      elapsed: "0s",
      events: [],
      evidence: [],
      finalAnswer: [],
      hud: {
        ...createInitialHUD(),
        currentStepTitle: "等待模型响应",
        status: "thinking"
      },
      id: input.id,
      model: input.model,
      patches: [],
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      startedAt,
      status: "running",
      tasks: [],
      title: input.prompt.slice(0, 38) || "新任务",
      turns: [],
      verification: []
    };

    this.runs.set(run.id, run);
    this.sequence.set(run.id, 0);
    this.addEvent(run.id, {
      body: "创建新的 agent run，并准备调用 DeepSeek。",
      status: "completed",
      title: "已开始处理请求",
      type: "run.started"
    });
    return cloneRun(run);
  }

  getRun(runId: string): AgentRun | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const subscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(runId, subscribers);

    const run = this.runs.get(runId);
    if (run) subscriber(cloneRun(run));

    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(runId);
    };
  }

  addEvent(
    runId: string,
    input: Omit<AgentEvent, "id" | "runId" | "sequence" | "timestamp" | "visibility"> & {
      visibility?: AgentEvent["visibility"];
    }
  ): AgentEvent | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    const nextSequence = (this.sequence.get(runId) ?? 0) + 1;
    this.sequence.set(runId, nextSequence);

    const event: AgentEvent = {
      id: `${runId}_event_${nextSequence}`,
      runId,
      sequence: nextSequence,
      timestamp: nowLabel(),
      visibility: input.visibility ?? "user",
      ...input
    };

    run.events.push(event);
    run.elapsed = elapsedLabel(run.startedAt, run.completedAt);
    this.publish(runId);
    return event;
  }

  addEvidence(
    runId: string,
    input: Omit<Evidence, "id" | "timestamp">
  ): Evidence | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const evidence: Evidence = {
      id: `${runId}_evidence_${run.evidence.length + 1}`,
      timestamp: nowLabel(),
      ...input
    };
    run.evidence.push(evidence);
    this.publish(runId);
    return evidence;
  }

  updateHUD(runId: string, patch: Partial<AgentRun["hud"]>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.hud = { ...run.hud, ...patch };
    run.elapsed = elapsedLabel(run.startedAt, run.completedAt);
    this.publish(runId);
  }

  updateDiff(runId: string, diffSummary: DiffSummary): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.diffSummary = diffSummary;
    run.patches = diffSummary.files;
    run.hud = {
      ...run.hud,
      additions: diffSummary.additions,
      changedFiles: diffSummary.changedFiles,
      deletions: diffSummary.deletions
    };
    this.addEvent(runId, {
      body: `${diffSummary.changedFiles} 个文件已更改，+${diffSummary.additions} -${diffSummary.deletions}`,
      meta: {
        fileCount: diffSummary.changedFiles,
        tokenSource: "runtime"
      },
      status: "completed",
      title: "工作区变更已更新",
      type: "workspace.diff.updated"
    });
  }

  updateTask(
    runId: string,
    input: {
      agentStatus?: AgentRun["tasks"][number]["agentStatus"];
      evidenceRef?: string;
      id: string;
      runtimeStatus?: AgentRun["tasks"][number]["runtimeStatus"];
      title?: string;
      verification?: VerificationRule;
    }
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;

    const existing = run.tasks.find((task) => task.id === input.id);
    const task =
      existing ??
      ({
        agentStatus: "planned",
        displayStatus: "待开始",
        evidenceRefs: [],
        id: input.id,
        runtimeStatus: "unverified",
        title: input.title ?? input.id
      } satisfies AgentRun["tasks"][number]);

    task.title = input.title ?? task.title;
    task.agentStatus = input.agentStatus ?? task.agentStatus;
    task.runtimeStatus = input.runtimeStatus ?? task.runtimeStatus;
    task.verification = input.verification ?? task.verification;
    if (input.evidenceRef && !task.evidenceRefs.includes(input.evidenceRef)) {
      task.evidenceRefs.push(input.evidenceRef);
    }
    task.displayStatus = deriveDisplayStatus(task.agentStatus, task.runtimeStatus);

    if (!existing) run.tasks.push(task);

    run.hud = {
      ...run.hud,
      currentStep: Math.max(1, run.tasks.findIndex((item) => item.id === task.id) + 1),
      currentStepTitle: task.title,
      totalSteps: Math.max(1, run.tasks.length)
    };

    this.addEvent(runId, {
      body: `${task.title}：${task.displayStatus}`,
      status: "completed",
      title: "任务状态已更新",
      type: "task.updated"
    });
  }

  completeRun(runId: string, finalText: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status === "cancelled") return;
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.elapsed = elapsedLabel(run.startedAt, run.completedAt);
    run.finalAnswer = finalText
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    run.hud = { ...run.hud, currentStepTitle: "已完成", status: "completed" };
    if (run.diffSummary.changedFiles > 0) {
      run.verification.push(
        `${run.diffSummary.changedFiles} 个文件已更改，+${run.diffSummary.additions} -${run.diffSummary.deletions}`
      );
    }
    this.addEvent(runId, {
      body: "模型已完成最终回答。",
      status: "completed",
      title: "已处理完成",
      type: "run.completed"
    });
    this.publish(runId);
  }

  failRun(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status === "completed" || run.status === "cancelled") return;
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    run.elapsed = elapsedLabel(run.startedAt, run.completedAt);
    run.finalAnswer = [message];
    run.hud = { ...run.hud, currentStepTitle: "运行失败", status: "failed" };
    this.addEvent(runId, {
      body: message,
      status: "failed",
      title: "运行失败",
      type: "run.failed"
    });
    this.publish(runId);
  }

  cancelRun(runId: string, message = "用户取消了运行。"): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    run.elapsed = elapsedLabel(run.startedAt, run.completedAt);
    run.finalAnswer = [message];
    run.hud = { ...run.hud, currentStepTitle: "已取消", status: "cancelled" };
    this.addEvent(runId, {
      body: message,
      status: "cancelled",
      title: "运行已取消",
      type: "run.cancelled"
    });
    this.publish(runId);
  }

  private publish(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const snapshot = cloneRun(run);
    this.subscribers.get(runId)?.forEach((subscriber) => subscriber(snapshot));
  }
}

export function eventTitleForTool(toolName: string): string {
  switch (toolName) {
    case "list_files":
      return "列出文件";
    case "read_file":
      return "读取文件";
    case "git_status":
      return "检查 Git 状态";
    case "run_command":
      return "运行命令";
    case "update_task":
      return "更新任务";
    default:
      return toolName;
  }
}

export type EventInput = Parameters<RunStore["addEvent"]>[1] & { type: AgentEventType; status?: AgentEventStatus };
