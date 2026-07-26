import { CheckCircle2, ChevronDown, CircleAlert, FileCode2, TerminalSquare, Wrench } from "lucide-react";
import React, { useState } from "react";
import { Activity, Plan } from "../../shared/contracts/runtime";
import {
  activityTitle,
  fileDisplayName,
  toolDisplayTarget,
  toolTarget
} from "../../shared/projections/activityPresentation";
import { useStreamText } from "../stream/useStreamText";
import { MarkdownContent } from "./MarkdownContent";
import { InlinePlanCard } from "./InlinePlanCard";

function iconFor(activity: Activity) {
  if (activity.kind === "command") return <TerminalSquare size={13} />;
  if (activity.kind === "file_mutation") return <FileCode2 size={13} />;
  if (activity.kind === "error" || activity.status === "failed") return <CircleAlert size={13} />;
  if (activity.kind === "tool") return <Wrench size={13} />;
  return <CheckCircle2 size={13} />;
}

function completedTitle(activity: Activity): string {
  if (activity.command?.timedOut) return "命令运行超时";
  if (activity.kind === "command" && activity.status === "failed") return "命令运行失败";
  if (activity.kind === "command" && activity.status === "cancelled") return "命令已取消";
  if (activity.status !== "completed") return activityTitle(activity);
  if (activity.kind === "command") {
    return activity.command?.command ? `已运行 ${activity.command.command}` : "命令执行完成";
  }
  const target = toolDisplayTarget(activity.tool);
  if (activity.tool && target) {
    if (activity.tool.action === "task") return "已更新执行任务";
    if (activity.tool.action === "plan") return "已更新方案";
    if (activity.tool.action === "modify") return `已修改 ${target}`;
    if (activity.tool.action === "inspect" || activity.tool.action === "search") return `已检查 ${target}`;
  }
  const firstLine = activity.body.split("\n", 1)[0]?.trim();
  if (firstLine?.startsWith("已") && firstLine.length <= 120) return firstLine;
  return activityTitle(activity);
}

function fileActionLabel(activity: Activity): string {
  if (activity.status === "failed") return "失败";
  if (activity.status === "cancelled") return "已取消";
  if (activity.tool?.toolName === "read_file") return activity.status === "running" ? "正在读取" : "已读取";
  if (activity.tool?.toolName === "grep") return activity.status === "running" ? "正在搜索" : "已搜索";
  if (activity.tool?.toolName === "glob") return activity.status === "running" ? "正在匹配" : "已匹配";
  if (activity.tool?.action === "modify") return activity.status === "running" ? "正在修改" : "已修改";
  if (activity.tool?.action === "search") return activity.status === "running" ? "正在搜索" : "已搜索";
  return activity.status === "running" ? "正在处理" : "已处理";
}

function MessageActivity({
  activity,
  onTextFrame,
  runActive
}: {
  activity: Activity;
  onTextFrame?: () => void;
  runActive: boolean;
}) {
  const streaming = runActive && activity.status === "running";
  const text = useStreamText(activity.body, streaming, onTextFrame);
  return (
    <article className="work-step content-step">
      <div className="work-body">
        <MarkdownContent fragments={text.fragments} stable={text.stable} streaming={streaming} />
      </div>
    </article>
  );
}

export function ActivityView({
  runActive,
  onOpenFile,
  onTextFrame,
  onOpenPlan,
  plan,
  activity
}: {
  runActive: boolean;
  onOpenFile: (path: string) => void;
  onTextFrame?: () => void;
  onOpenPlan: (runId: string, callId: string) => void;
  plan?: Plan;
  activity: Activity;
}) {
  const [commandExpanded, setCommandExpanded] = useState(false);
  if (activity.audience === "internal") return null;
  if (activity.kind === "thinking") {
    if (!runActive || (activity.status !== "running" && activity.status !== "suspended")) return null;
    return (
      <article className="work-step tool-step thinking-step is-expanded">
        <div className="work-body">
          <strong className="purpose-sweep">
            正在思考
          </strong>
        </div>
      </article>
    );
  }
  if (activity.kind === "message") {
    return <MessageActivity activity={activity} onTextFrame={onTextFrame} runActive={runActive} />;
  }
  if (activity.kind === "user_message") {
    return <article className="user-turn steer-user-turn"><p>{activity.body}</p></article>;
  }
  if (activity.kind === "plan" && activity.tool?.callId) {
    return <InlinePlanCard activity={activity} onOpen={() => onOpenPlan(activity.runId, activity.tool!.callId)} onTextFrame={onTextFrame} plan={plan} runActive={runActive} />;
  }
  if (activity.kind === "command") {
    const status = activity.command?.timedOut
      ? "执行超时"
      : activity.command?.exitCode === undefined ? "" : `退出码 ${activity.command.exitCode}`;
    const output = [status, activity.body].filter(Boolean).join("\n\n") || "命令执行完成，无输出。";
    return (
      <article className={`work-step tool-step command-step is-${activity.status}`}>
        <div className="work-dot">{iconFor(activity)}</div>
        <div className="work-body">
          <button
            aria-expanded={commandExpanded}
            className="command-step-toggle"
            onClick={() => setCommandExpanded((value) => !value)}
            type="button"
          >
            <strong>{completedTitle(activity)}</strong>
            <ChevronDown size={12} />
          </button>
          {activity.status === "running" && <p className="muted-line working-glow">正在执行</p>}
          {commandExpanded && <pre className="activity-output">{output}</pre>}
        </div>
      </article>
    );
  }
  const fileTarget = activity.tool?.targetKind === "file" ? activity.tool : undefined;
  const fileLabel = toolTarget(fileTarget);
  return (
    <article className={`work-step tool-step is-${activity.status}`}>
      <div className="work-dot">{iconFor(activity)}</div>
      <div className="work-body">
        {fileTarget ? (
          <strong className="inline-file-reference">
            <span className={activity.status === "running" ? "working-glow" : ""}>{fileActionLabel(activity)}</span>
            <button onClick={() => onOpenFile(fileTarget.normalizedTarget)} title={fileLabel} type="button">
              {fileDisplayName(fileLabel)}
            </button>
          </strong>
        ) : (
          <strong>{completedTitle(activity)}</strong>
        )}
        {activity.status === "running" && !fileTarget && <p className="muted-line working-glow">正在执行</p>}
        {activity.status === "failed" && activity.body && <pre className="activity-output">{activity.body}</pre>}
      </div>
    </article>
  );
}
