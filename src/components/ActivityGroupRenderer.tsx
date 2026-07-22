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
  Activity,
  FileChange,
  ActivityGroup,
  Changes,
  ToolAggregate
} from "../../shared/contracts/runtime";
import { CodeDiffViewer } from "./CodeEditorSurface";
import { DetailPanel } from "./DetailPanel";

function groupIcon(group: ActivityGroup) {
  if (group.status === "failed") return <CircleAlert size={13} />;
  if (group.category === "modify") return <PencilLine size={13} />;
  if (group.category === "verify") return <TestTube2 size={13} />;
  if (group.category === "execute") return <TerminalSquare size={13} />;
  if (group.category === "external") return <CheckCircle2 size={13} />;
  return <FolderSearch size={13} />;
}

function memberIcon(activity: Activity) {
  if (activity.tool?.toolName === "read_file") return <Files size={12} />;
  if (activity.tool?.toolName === "list_files") return <ListTree size={12} />;
  if (activity.tool?.action === "search") return <Search size={12} />;
  if (activity.tool?.action === "modify") return <PencilLine size={12} />;
  if (activity.tool?.action === "verify") return <TestTube2 size={12} />;
  return <TerminalSquare size={12} />;
}

function memberLabel(activity: Activity): string {
  const target = activity.tool?.displayTarget || activity.title;
  if (activity.command?.timedOut) return `已超时 ${target}`;
  if (activity.status === "failed") return `失败 ${target}`;
  if (activity.status === "cancelled") return `已取消 ${target}`;
  if (activity.tool?.toolName === "run_command") return `${activity.status === "running" ? "正在运行" : "已运行"} ${target}`;
  if (activity.tool?.toolName === "read_file") return `${activity.status === "running" ? "正在读取" : "已读取"} ${target}`;
  if (activity.tool?.toolName === "list_files") return `${activity.status === "running" ? "正在列出" : "已列出"} ${target}`;
  if (activity.tool?.toolName === "grep") return `${activity.status === "running" ? "正在搜索" : "已搜索"} ${target}`;
  if (activity.tool?.toolName === "glob") return `${activity.status === "running" ? "正在匹配" : "已匹配"} ${target}`;
  if (activity.tool?.action === "search") return `${activity.status === "running" ? "正在搜索" : "已搜索"} ${target}`;
  if (activity.tool?.action === "modify") return `${activity.status === "running" ? "正在修改" : "已修改"} ${target}`;
  return `${activity.status === "running" ? "正在执行" : "已完成"} ${target}`;
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

function directActionLabel(activity: Activity): string {
  const active = activity.status === "running";
  if (activity.status === "failed") {
    if (activity.tool?.action === "modify") return "修改失败";
    if (activity.tool?.toolName === "read_file") return "读取失败";
    if (activity.tool?.toolName === "grep") return "搜索失败";
    if (activity.tool?.toolName === "glob") return "匹配失败";
    return "执行失败";
  }
  if (activity.status === "cancelled") return "已取消";
  if (activity.tool?.toolName === "write_file") return active ? "正在创建" : "已创建";
  if (activity.tool?.toolName === "edit_file") return active ? "正在编辑" : "已编辑";
  if (activity.tool?.toolName === "delete_file") return active ? "正在删除" : "已删除";
  if (activity.tool?.toolName === "read_file") return active ? "正在读取" : "已读取";
  if (activity.tool?.toolName === "grep") return active ? "正在搜索" : "已搜索";
  if (activity.tool?.toolName === "glob") return active ? "正在匹配" : "已匹配";
  if (activity.tool?.action === "search") return active ? "正在搜索" : "已搜索";
  return active ? "正在处理" : "已处理";
}

function expandedActionLabel(group: ActivityGroup, members: Activity[]): string {
  if (group.category === "modify") return "已编辑的文件";
  if (group.category === "execute") return group.status === "failed" ? "运行失败的命令" : "已运行的命令";
  if (group.category === "verify") return group.status === "failed" ? "验证失败的命令" : "已验证的命令";
  if (members.every((activity) => activity.tool?.toolName === "read_file")) return "已读取的文件";
  if (members.every((activity) => activity.tool?.toolName === "grep")) return group.status === "failed" ? "失败的搜索" : "搜索记录";
  if (members.every((activity) => activity.tool?.toolName === "glob")) return group.status === "failed" ? "失败的匹配" : "匹配记录";
  if (members.every((activity) => activity.tool?.action === "search")) return "搜索记录";
  return "检查记录";
}

function modificationAction(operation: FileChange["operation"], active = false): string {
  if (operation === "created") return active ? "正在创建" : "已创建";
  if (operation === "deleted") return active ? "正在删除" : "已删除";
  return active ? "正在编辑" : "已编辑";
}

function modificationGroupLabel(
  group: ActivityGroup,
  changedFiles: FileChange[]
): string {
  if (group.status === "failed" && group.failureCount === group.totalCalls) return "文件修改失败";
  const active = group.status === "running";
  const action = active ? "正在编辑" : "已编辑";
  const fileCount = group.changes?.fileCount || changedFiles.length || group.uniqueTargets.length || group.totalCalls;
  return `${action} ${fileCount} 个文件`;
}

function commandOutput(activity: Activity): string {
  const exit = activity.command?.timedOut
    ? "执行超时"
    : activity.command?.exitCode === undefined ? "" : `退出码 ${activity.command.exitCode}`;
  const command = activity.tool?.displayTarget ? `$ ${activity.tool.displayTarget}` : "";
  return [command, activity.body, exit].filter(Boolean).join("\n\n") || "命令执行完成，无输出。";
}

function detailTitle(activity: Activity): string {
  if (activity.tool?.toolName === "run_command") return "Shell";
  if (activity.tool?.toolName === "grep") return "grep";
  if (activity.tool?.toolName === "glob") return "glob";
  if (activity.tool?.toolName === "read_file") return activity.tool.displayTarget || "文件内容";
  if (activity.tool?.toolName === "list_files") return "目录内容";
  if (activity.tool?.action === "search") return "搜索结果";
  return activity.tool?.displayTarget || activity.title || "执行结果";
}

function detailContent(activity: Activity): string {
  if (activity.tool?.toolName === "run_command") return commandOutput(activity);
  return activity.body || activity.error || activity.tool?.argumentsPreview || "操作已完成。";
}

function OperationMemberRow({
  onOpenFile,
  activity
}: {
  onOpenFile: (path: string) => void;
  activity: Activity;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFileReference = activity.tool?.targetKind === "file" && Boolean(activity.tool.displayTarget);
  return (
    <div className={`operation-member-call is-${activity.status}`}>
      <div
        aria-expanded={expanded}
        className={`operation-call-row is-expandable is-${activity.status}`}
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
        <span>{memberIcon(activity)}</span>
        {isFileReference ? (
          <span className="operation-file-reference">
            <span>{fileActionLabel(activity)}</span>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onOpenFile(activity.tool!.normalizedTarget);
              }}
              title={activity.tool!.displayTarget}
              type="button"
            >
              {activity.tool!.displayTarget}
            </button>
          </span>
        ) : (
          <span className={activity.status === "running" ? "working-glow" : ""} title={memberLabel(activity)}>{memberLabel(activity)}</span>
        )}
        <ChevronRight className="operation-member-chevron" size={12} />
      </div>
      <div className={`operation-command-expander ${expanded ? "is-expanded" : ""}`}>
        <div>{expanded && (
          <DetailPanel copyValue={detailContent(activity)} title={detailTitle(activity)}>
            <pre className="operation-detail-text">{detailContent(activity)}</pre>
          </DetailPanel>
        )}</div>
      </div>
    </div>
  );
}

export function ModificationFileRow({
  file,
  onOpenFile,
  active = false,
  showIcon = true
}: {
  file: FileChange;
  onOpenFile: (path: string) => void;
  active?: boolean;
  showIcon?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasPatch = Boolean(file.patch?.trim());
  return (
    <div className={`operation-modification-file ${active ? "is-running" : ""} ${expanded ? "is-expanded" : ""}`}>
      <div
        aria-expanded={expanded}
        className="operation-file-summary"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".operation-file-summary-name")) return;
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
        {showIcon && <span className="operation-file-summary-icon"><PencilLine size={13} /></span>}
        <span className={`operation-file-summary-action ${active ? "working-glow" : ""}`}>{modificationAction(file.operation, active)}</span>
        <button
          className="operation-file-summary-name"
          onClick={(event) => {
            event.stopPropagation();
            onOpenFile(file.path);
          }}
          title={file.path}
          type="button"
        >
          {file.path}
        </button>
        <span className={`operation-diff-metrics ${active ? "is-live" : ""}`}><b>+{file.additions}</b> <i>-{file.deletions}</i></span>
        <ChevronRight className="operation-file-summary-chevron" size={13} />
      </div>
      <div className={`operation-file-detail-expander ${expanded ? "is-expanded" : ""}`}>
        <div>{expanded && (
          <DetailPanel copyValue={file.patch ?? ""} title={file.path}>
            {hasPatch
              ? <CodeDiffViewer compact patch={file.patch!} path={file.path} />
              : <div className="operation-detail-empty">暂无可展示的变更内容。</div>}
          </DetailPanel>
        )}</div>
      </div>
    </div>
  );
}

export function ActivityGroupRenderer({
  group,
  onOpenFile,
  activities,
  changes
}: {
  group: ActivityGroup;
  onOpenFile: (path: string) => void;
  activities: Activity[];
  changes: Changes;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const members = useMemo(() => {
    const keys = new Set(group.memberActivityIds);
    return activities.filter((activity) => keys.has(activity.activityId));
  }, [group.memberActivityIds, activities]);
  const fileTargets = useMemo(
    () => [...new Set(members.filter((activity) => activity.tool?.targetKind === "file").map((activity) => activity.tool!.normalizedTarget))],
    [members]
  );
  const changedFiles = useMemo(() => {
    const targets = new Set(members.map((activity) => activity.tool?.normalizedTarget).filter(Boolean));
    return changes.comparisonBase === "run_start"
      ? changes.files.filter((file) => targets.has(file.path.replaceAll("\\", "/")))
      : [];
  }, [members, changes]);
  const directFile = group.category !== "modify" && group.totalCalls === 1 && fileTargets.length === 1
    ? fileTargets[0]
    : undefined;
  const directMember = directFile ? members[0] : undefined;
  const metrics = group.category === "modify" && group.changes
    ? group.changes
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
  const collapsedLabel = group.category === "modify"
    ? modificationGroupLabel(group, changedFiles)
    : directMember
      ? directActionLabel(directMember)
      : group.summaryLabel.replace(/\s\+\d+\s-\d+(?=\s|$)/, "");

  return (
    <article className={`operation-group is-${group.status} ${expanded ? "is-expanded" : ""}`}>
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
        <span className={`operation-group-action ${group.status === "running" ? "working-glow" : ""}`}>{expanded ? expandedActionLabel(group, members) : collapsedLabel}</span>
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
                    <ModificationFileRow
                      file={file}
                      key={file.path}
                      onOpenFile={onOpenFile}
                    />
                  ))
                : members.map((activity) => (
                    <OperationMemberRow key={activity.activityId} onOpenFile={onOpenFile} activity={activity} />
                  ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function aggregateIcon(aggregate: ToolAggregate) {
  return aggregate.status === "failed" ? <CircleAlert size={13} /> : <CheckCircle2 size={13} />;
}

export function ActivityAggregateRenderer({
  aggregate,
  onOpenFile,
  activities,
  changes
}: {
  aggregate: ToolAggregate;
  onOpenFile: (path: string) => void;
  activities: Activity[];
  changes: Changes;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const members = useMemo(() => {
    const keys = new Set(aggregate.memberActivityIds);
    return activities.filter((activity) => keys.has(activity.activityId));
  }, [aggregate.memberActivityIds, activities]);
  const changedFiles = useMemo(() => {
    if (changes.comparisonBase !== "run_start") return new Map<string, FileChange>();
    return new Map(changes.files.map((file) => [file.path.replaceAll("\\", "/"), file]));
  }, [changes]);
  const toggleExpanded = () => {
    setHasOpened(true);
    setExpanded((value) => !value);
  };
  const handleSummaryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleExpanded();
  };

  return (
    <article className={`operation-group activity-aggregate is-${aggregate.status} ${expanded ? "is-expanded" : ""}`}>
      <div
        aria-expanded={expanded}
        className="operation-group-summary"
        onClick={toggleExpanded}
        onKeyDown={handleSummaryKeyDown}
        role="button"
        tabIndex={0}
      >
        <span className="operation-group-icon">{aggregateIcon(aggregate)}</span>
        <span className="operation-group-action">{aggregate.summaryLabel}</span>
        <ChevronRight className="operation-summary-chevron" size={13} />
      </div>
      <div className={`operation-group-expander ${expanded ? "is-expanded" : ""}`}>
        <div>
          {hasOpened && (
            <div className="operation-group-details" aria-label="已完成的工具调用">
              {members.map((activity) => {
                const changedFile = activity.tool?.action === "modify"
                  ? (activity.files?.find((file) => file.path.replaceAll("\\", "/") === activity.tool?.normalizedTarget)
                    ?? changedFiles.get(activity.tool.normalizedTarget))
                  : undefined;
                return changedFile
                  ? <ModificationFileRow file={changedFile} key={activity.activityId} onOpenFile={onOpenFile} />
                  : <OperationMemberRow activity={activity} key={activity.activityId} onOpenFile={onOpenFile} />;
              })}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
