import { FileCode2, FolderGit2, GitBranch, HardDrive } from "lucide-react";
import { Changes, Session } from "../../shared/contracts/runtime";
import { RuntimeWorkspace } from "../runtimeApi";

export function EnvironmentPanel({
  onOpenReview,
  session,
  workspace
}: {
  onOpenReview: (delta?: Changes) => void;
  session: Session | null;
  workspace: RuntimeWorkspace | null;
}) {
  const run = session?.runs.at(-1);
  const delta = run?.changes.comparisonBase === "run_start" ? run.changes : undefined;
  const fileCount = delta?.fileCount ?? 0;
  const workspaceLabel = session?.workspaceKind === "scratch"
    ? "临时工作区"
    : workspace?.name ?? session?.projectRoot ?? "尚未选择项目";
  return (
    <section className="environment-section">
      <header><span>运行环境</span></header>
      <div className="environment-row"><HardDrive size={15} /><span>本地 Runtime</span></div>
      <div className="environment-row" title={session?.workspaceKind === "scratch" ? "临时工作区" : session?.projectRoot}><FolderGit2 size={15} /><span>{workspaceLabel}</span></div>
      <div className="environment-row"><GitBranch size={15} /><span>{workspace?.git ? workspace.branch || "detached HEAD" : session ? "非 Git 工作区" : "尚未连接"}</span></div>
      {fileCount > 0 ? (
        <button className="environment-row" onClick={() => onOpenReview(delta)} type="button">
          <FileCode2 size={15} />
          <span>{fileCount} 个文件变更</span>
        </button>
      ) : (
        <div className="environment-row"><FileCode2 size={15} /><span>0 个文件变更</span></div>
      )}
    </section>
  );
}
