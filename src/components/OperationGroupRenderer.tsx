import {
  ChevronDown,
  Files,
  FolderSearch,
  ListTree,
  PencilLine,
  Search,
  TestTube2,
  TerminalSquare
} from "lucide-react";
import { useMemo, useState } from "react";
import { ActivityUnitView, FileDeltaView, OperationGroupView } from "../../shared/runtimeTypes";

function groupIcon(group: OperationGroupView) {
  if (group.category === "modify") return <PencilLine size={13} />;
  if (group.category === "verify") return <TestTube2 size={13} />;
  if (group.category === "execute") return <TerminalSquare size={13} />;
  return <FolderSearch size={13} />;
}

function memberIcon(unit: ActivityUnitView) {
  if (unit.tool?.toolName === "read_file") return <Files size={12} />;
  if (unit.tool?.toolName === "list_files") return <ListTree size={12} />;
  if (unit.tool?.operationClass === "search") return <Search size={12} />;
  if (unit.tool?.operationClass === "modify") return <PencilLine size={12} />;
  if (unit.tool?.operationClass === "verify") return <TestTube2 size={12} />;
  return <TerminalSquare size={12} />;
}

function memberLabel(unit: ActivityUnitView): string {
  const target = unit.tool?.displayTarget || unit.title;
  if (unit.phase === "failed") return `失败 ${target}`;
  if (unit.phase === "cancelled") return `已取消 ${target}`;
  if (unit.tool?.toolName === "run_command") return `${unit.phase === "open" ? "正在运行" : "已运行"} ${target}`;
  if (unit.tool?.toolName === "read_file") return `${unit.phase === "open" ? "正在读取" : "已读取"} ${target}`;
  if (unit.tool?.toolName === "list_files") return `${unit.phase === "open" ? "正在列出" : "已列出"} ${target}`;
  if (unit.tool?.operationClass === "search") return `${unit.phase === "open" ? "正在搜索" : "已搜索"} ${target}`;
  if (unit.tool?.operationClass === "modify") return `${unit.phase === "open" ? "正在修改" : "已修改"} ${target}`;
  return `${unit.phase === "open" ? "正在执行" : "已完成"} ${target}`;
}

function fileActionLabel(unit: ActivityUnitView): string {
  if (unit.phase === "failed") return "失败";
  if (unit.phase === "cancelled") return "已取消";
  if (unit.tool?.toolName === "read_file") return unit.phase === "open" ? "正在读取" : "已读取";
  if (unit.tool?.operationClass === "modify") return unit.phase === "open" ? "正在修改" : "已修改";
  if (unit.tool?.operationClass === "search") return unit.phase === "open" ? "正在搜索" : "已搜索";
  return unit.phase === "open" ? "正在处理" : "已处理";
}

function commandOutput(unit: ActivityUnitView): string {
  const exit = unit.command?.exitCode === undefined ? "" : `退出码 ${unit.command.exitCode}`;
  return [exit, unit.body].filter(Boolean).join("\n\n") || "命令执行完成，无输出。";
}

function OperationMemberRow({
  onOpenFile,
  unit
}: {
  onOpenFile: (path: string, file?: FileDeltaView) => void;
  unit: ActivityUnitView;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCommand = unit.tool?.toolName === "run_command";
  const isFileReference = unit.tool?.resourceKind === "file" && Boolean(unit.tool.displayTarget);
  if (!isCommand) {
    return (
      <div className={`operation-call-row is-${unit.phase}`}>
        <span>{memberIcon(unit)}</span>
        {isFileReference ? (
          <span className="operation-file-reference">
            <span>{fileActionLabel(unit)}</span>
            <button onClick={() => onOpenFile(unit.tool!.normalizedTarget)} title={unit.tool!.displayTarget} type="button">
              {unit.tool!.displayTarget}
            </button>
          </span>
        ) : (
          <span title={memberLabel(unit)}>{memberLabel(unit)}</span>
        )}
      </div>
    );
  }
  return (
    <div className={`operation-command-call is-${unit.phase}`}>
      <button
        aria-expanded={expanded}
        className="operation-call-row is-command"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>{memberIcon(unit)}</span>
        <span title={memberLabel(unit)}>{memberLabel(unit)}</span>
        <ChevronDown size={12} />
      </button>
      {expanded && <pre className="operation-command-output">{commandOutput(unit)}</pre>}
    </div>
  );
}

export function OperationGroupRenderer({
  group,
  onOpenFile,
  units
}: {
  group: OperationGroupView;
  onOpenFile: (path: string, file?: FileDeltaView) => void;
  units: ActivityUnitView[];
}) {
  const [expanded, setExpanded] = useState(false);
  const members = useMemo(() => {
    const keys = new Set(group.memberUnitKeys);
    return units.filter((unit) => keys.has(unit.unitKey));
  }, [group.memberUnitKeys, units]);

  return (
    <article className={`operation-group is-${group.phase}`}>
      <button
        aria-expanded={expanded}
        className="operation-group-summary"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="operation-group-icon">{groupIcon(group)}</span>
        <span className="operation-group-copy">
          <strong>{group.summaryLabel}</strong>
        </span>
        <ChevronDown size={13} />
      </button>

      {expanded && (
        <div className="operation-group-details" aria-label="工具调用记录">
          {members.map((unit) => (
            <OperationMemberRow key={unit.unitKey} onOpenFile={onOpenFile} unit={unit} />
          ))}
        </div>
      )}
    </article>
  );
}
