import { CheckCircle2, ChevronDown, CircleAlert, FileCode2, TerminalSquare, Wrench } from "lucide-react";
import { useState } from "react";
import { ActivityUnitView } from "../../shared/runtimeTypes";

function iconFor(unit: ActivityUnitView) {
  if (unit.kind === "command") return <TerminalSquare size={13} />;
  if (unit.kind === "file_mutation") return <FileCode2 size={13} />;
  if (unit.kind === "error" || unit.phase === "failed") return <CircleAlert size={13} />;
  if (unit.kind === "tool") return <Wrench size={13} />;
  return <CheckCircle2 size={13} />;
}

function completedTitle(unit: ActivityUnitView): string {
  if (unit.command?.timedOut) return "命令运行超时";
  if (unit.kind === "command" && unit.phase === "failed") return "命令运行失败";
  if (unit.kind === "command" && unit.phase === "cancelled") return "命令已取消";
  if (unit.phase !== "succeeded") return unit.title;
  if (unit.kind === "command") {
    return unit.command?.command ? `已运行 ${unit.command.command}` : "命令执行完成";
  }
  if (unit.tool?.displayTarget) {
    if (unit.tool.operationClass === "plan") return "已更新计划";
    if (unit.tool.operationClass === "modify") return `已修改 ${unit.tool.displayTarget}`;
    if (unit.tool.operationClass === "inspect" || unit.tool.operationClass === "search") return `已检查 ${unit.tool.displayTarget}`;
  }
  const firstLine = unit.body.split("\n", 1)[0]?.trim();
  if (firstLine?.startsWith("已") && firstLine.length <= 120) return firstLine;
  return unit.title;
}

function fileActionLabel(unit: ActivityUnitView): string {
  if (unit.phase === "failed") return "失败";
  if (unit.phase === "cancelled") return "已取消";
  if (unit.tool?.toolName === "read_file") return unit.phase === "open" ? "正在读取" : "已读取";
  if (unit.tool?.operationClass === "modify") return unit.phase === "open" ? "正在修改" : "已修改";
  if (unit.tool?.operationClass === "search") return unit.phase === "open" ? "正在搜索" : "已搜索";
  return unit.phase === "open" ? "正在处理" : "已处理";
}

export function ActivityRenderer({
  cycleActive,
  onOpenFile,
  unit
}: {
  cycleActive: boolean;
  onOpenFile: (path: string) => void;
  unit: ActivityUnitView;
}) {
  const [commandExpanded, setCommandExpanded] = useState(false);
  if (unit.audience === "internal") return null;
  if (unit.kind === "thinking") {
    if (!cycleActive || unit.phase !== "open") return null;
    return (
      <article className="work-step thinking-step is-expanded">
        <div className="work-body">
          <strong className="working-glow">正在思考</strong>
        </div>
      </article>
    );
  }
  if (unit.kind === "message") {
    return (
      <article className="work-step content-step">
        <div className="work-body"><p>{unit.body}<span className={unit.phase === "open" ? "streaming-caret" : ""} /></p></div>
      </article>
    );
  }
  if (unit.kind === "command") {
    const status = unit.command?.timedOut
      ? "执行超时"
      : unit.command?.exitCode === undefined ? "" : `退出码 ${unit.command.exitCode}`;
    const output = [status, unit.body].filter(Boolean).join("\n\n") || "命令执行完成，无输出。";
    return (
      <article className={`work-step tool-step command-step is-${unit.phase}`}>
        <div className="work-dot">{iconFor(unit)}</div>
        <div className="work-body">
          <button
            aria-expanded={commandExpanded}
            className="command-step-toggle"
            onClick={() => setCommandExpanded((value) => !value)}
            type="button"
          >
            <strong>{completedTitle(unit)}</strong>
            <ChevronDown size={12} />
          </button>
          {unit.phase === "open" && <p className="muted-line working-glow">正在执行</p>}
          {commandExpanded && <pre className="activity-output">{output}</pre>}
        </div>
      </article>
    );
  }
  const fileTarget = unit.tool?.resourceKind === "file" ? unit.tool : undefined;
  return (
    <article className={`work-step tool-step is-${unit.phase}`}>
      <div className="work-dot">{iconFor(unit)}</div>
      <div className="work-body">
        {fileTarget ? (
          <strong className="inline-file-reference">
            <span className={unit.phase === "open" ? "working-glow" : ""}>{fileActionLabel(unit)}</span>
            <button onClick={() => onOpenFile(fileTarget.normalizedTarget)} title={fileTarget.displayTarget} type="button">
              {fileTarget.displayTarget}
            </button>
          </strong>
        ) : (
          <strong>{completedTitle(unit)}</strong>
        )}
        {unit.phase === "open" && !fileTarget && <p className="muted-line working-glow">正在执行</p>}
        {unit.phase === "failed" && unit.body && <pre className="activity-output">{unit.body}</pre>}
      </div>
    </article>
  );
}
