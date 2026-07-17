import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Files,
  FolderSearch,
  ListTree,
  PencilLine,
  Search,
  TestTube2,
  TerminalSquare
} from "lucide-react";
import { KeyboardEvent, useMemo, useState } from "react";
import {
  ActivityUnitView,
  FileDeltaView,
  OperationGroupView,
  WorkspaceDeltaView
} from "../../shared/runtimeTypes";
import { CodeDiffViewer } from "./CodeEditorSurface";
import { OperationDetailPanel } from "./OperationDetailPanel";

function groupIcon(group: OperationGroupView) {
  if (group.phase === "failed") return <CircleAlert size={13} />;
  if (group.category === "modify") return <PencilLine size={13} />;
  if (group.category === "verify") return <TestTube2 size={13} />;
  if (group.category === "execute") return <TerminalSquare size={13} />;
  if (group.category === "external") return <CheckCircle2 size={13} />;
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
  if (unit.command?.timedOut) return `已超时 ${target}`;
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

function directActionLabel(unit: ActivityUnitView): string {
  const active = unit.phase === "open";
  if (unit.phase === "failed") {
    if (unit.tool?.operationClass === "modify") return "修改失败";
    if (unit.tool?.toolName === "read_file") return "读取失败";
    return "执行失败";
  }
  if (unit.phase === "cancelled") return "已取消";
  if (unit.tool?.toolName === "write_file") return active ? "正在创建" : "已创建";
  if (unit.tool?.toolName === "edit_file") return active ? "正在编辑" : "已编辑";
  if (unit.tool?.toolName === "delete_file") return active ? "正在删除" : "已删除";
  if (unit.tool?.toolName === "read_file") return active ? "正在读取" : "已读取";
  if (unit.tool?.operationClass === "search") return active ? "正在搜索" : "已搜索";
  return active ? "正在处理" : "已处理";
}

function expandedActionLabel(group: OperationGroupView, members: ActivityUnitView[]): string {
  const first = members[0];
  if (group.category === "modify") {
    if (first?.tool?.toolName === "write_file") return "已创建的文件";
    if (first?.tool?.toolName === "delete_file") return "已删除的文件";
    return "已编辑的文件";
  }
  if (group.category === "execute") return group.phase === "failed" ? "运行失败的命令" : "已运行的命令";
  if (group.category === "verify") return group.phase === "failed" ? "验证失败的命令" : "已验证的命令";
  if (members.every((unit) => unit.tool?.toolName === "read_file")) return "已读取的文件";
  if (members.every((unit) => unit.tool?.operationClass === "search")) return "搜索记录";
  return "检查记录";
}

function commandOutput(unit: ActivityUnitView): string {
  const exit = unit.command?.timedOut
    ? "执行超时"
    : unit.command?.exitCode === undefined ? "" : `退出码 ${unit.command.exitCode}`;
  const command = unit.tool?.displayTarget ? `$ ${unit.tool.displayTarget}` : "";
  return [command, unit.body, exit].filter(Boolean).join("\n\n") || "命令执行完成，无输出。";
}

function detailTitle(unit: ActivityUnitView): string {
  if (unit.tool?.toolName === "run_command") return "Shell";
  if (unit.tool?.toolName === "read_file") return unit.tool.displayTarget || "文件内容";
  if (unit.tool?.toolName === "list_files") return "目录内容";
  if (unit.tool?.operationClass === "search") return "搜索结果";
  return unit.tool?.displayTarget || unit.title || "执行结果";
}

function detailContent(unit: ActivityUnitView): string {
  if (unit.tool?.toolName === "run_command") return commandOutput(unit);
  return unit.body || unit.error || unit.tool?.argumentsPreview || "操作已完成。";
}

function OperationMemberRow({
  onOpenFile,
  unit
}: {
  onOpenFile: (path: string) => void;
  unit: ActivityUnitView;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFileReference = unit.tool?.resourceKind === "file" && Boolean(unit.tool.displayTarget);
  return (
    <div className={`operation-member-call is-${unit.phase}`}>
      <div
        aria-expanded={expanded}
        className={`operation-call-row is-expandable is-${unit.phase}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".operation-file-reference button")) return;
          setExpanded((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          setExpanded((value) => !value);
        }}
        role="button"
        tabIndex={0}
      >
        <span>{memberIcon(unit)}</span>
        {isFileReference ? (
          <span className="operation-file-reference">
            <span>{fileActionLabel(unit)}</span>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onOpenFile(unit.tool!.normalizedTarget);
              }}
              title={unit.tool!.displayTarget}
              type="button"
            >
              {unit.tool!.displayTarget}
            </button>
          </span>
        ) : (
          <span title={memberLabel(unit)}>{memberLabel(unit)}</span>
        )}
        <ChevronRight className="operation-member-chevron" size={12} />
      </div>
      <div className={`operation-command-expander ${expanded ? "is-expanded" : ""}`}>
        <div>{expanded && (
          <OperationDetailPanel copyValue={detailContent(unit)} title={detailTitle(unit)}>
            <pre className="operation-detail-text">{detailContent(unit)}</pre>
          </OperationDetailPanel>
        )}</div>
      </div>
    </div>
  );
}

function InlineFileDiff({
  defaultExpanded,
  file,
  onOpenFile
}: {
  defaultExpanded: boolean;
  file: FileDeltaView;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasPatch = Boolean(file.patch?.trim());
  return (
    <OperationDetailPanel
      className="operation-inline-diff"
      collapsible={!defaultExpanded && hasPatch}
      copyValue={file.patch ?? ""}
      expanded={!hasPatch || expanded}
      meta={<span className="operation-diff-metrics"><b>+{file.additions}</b> <i>-{file.deletions}</i></span>}
      onTitleClick={() => onOpenFile(file.path)}
      onToggle={() => setExpanded((value) => !value)}
      title={file.path}
    >
      {hasPatch ? <CodeDiffViewer compact patch={file.patch!} path={file.path} /> : <div className="operation-detail-empty">暂无可展示的变更内容。</div>}
    </OperationDetailPanel>
  );
}

export function OperationGroupRenderer({
  group,
  onOpenFile,
  units,
  workspaceDelta
}: {
  group: OperationGroupView;
  onOpenFile: (path: string) => void;
  units: ActivityUnitView[];
  workspaceDelta: WorkspaceDeltaView;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const members = useMemo(() => {
    const keys = new Set(group.memberUnitKeys);
    return units.filter((unit) => keys.has(unit.unitKey));
  }, [group.memberUnitKeys, units]);
  const fileTargets = useMemo(
    () => [...new Set(members.filter((unit) => unit.tool?.resourceKind === "file").map((unit) => unit.tool!.normalizedTarget))],
    [members]
  );
  const changedFiles = useMemo(() => {
    const targets = new Set(members.map((unit) => unit.tool?.normalizedTarget).filter(Boolean));
    return workspaceDelta.comparisonBase === "cycle_start"
      ? workspaceDelta.files.filter((file) => targets.has(file.path.replaceAll("\\", "/")))
      : [];
  }, [members, workspaceDelta]);
  const directFile = group.totalCalls === 1 && fileTargets.length === 1 ? fileTargets[0] : undefined;
  const directMember = directFile ? members[0] : undefined;
  const metrics = group.category === "modify" && group.workspaceDelta && group.phase !== "open"
    ? group.workspaceDelta
    : undefined;
  const toggleExpanded = () => {
    setHasOpened(true);
    setExpanded((value) => !value);
  };
  const handleSummaryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleExpanded();
  };
  const collapsedLabel = directMember
    ? directActionLabel(directMember)
    : group.summaryLabel.replace(/\s\+\d+\s-\d+(?=\s|$)/, "");

  return (
    <article className={`operation-group is-${group.phase} ${expanded ? "is-expanded" : ""}`}>
      <div
        aria-expanded={expanded}
        className={`operation-group-summary ${directFile && !expanded ? "has-direct-file" : ""}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".operation-summary-file")) return;
          toggleExpanded();
        }}
        onKeyDown={handleSummaryKeyDown}
        role="button"
        tabIndex={0}
      >
        <span className="operation-group-icon">{groupIcon(group)}</span>
        <span className="operation-group-action">{expanded ? expandedActionLabel(group, members) : collapsedLabel}</span>
        {directFile && !expanded && (
          <button
            className="operation-summary-file"
            onClick={(event) => {
              event.stopPropagation();
              onOpenFile(directFile);
            }}
            title={directFile}
            type="button"
          >
            {directFile}
          </button>
        )}
        {metrics && !expanded && (
          <span className="operation-diff-metrics"><b>+{metrics.additions}</b> <i>-{metrics.deletions}</i></span>
        )}
        <ChevronRight className="operation-summary-chevron" size={13} />
      </div>

      <div className={`operation-group-expander ${expanded ? "is-expanded" : ""}`}>
        <div>
          {hasOpened && (
            <div className={`operation-group-details is-${group.category}`} aria-label="工具调用记录">
              {group.category === "modify" && changedFiles.length > 0
                ? changedFiles.map((file) => (
                    <InlineFileDiff
                      defaultExpanded={changedFiles.length === 1}
                      file={file}
                      key={file.path}
                      onOpenFile={onOpenFile}
                    />
                  ))
                : members.map((unit) => (
                    <OperationMemberRow key={unit.unitKey} onOpenFile={onOpenFile} unit={unit} />
                  ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
