import { FileCode2, FolderGit2, GitBranch, HardDrive } from "lucide-react";
import { WorkspaceSessionView } from "../../shared/runtimeTypes";

export function EnvironmentPanel({ session }: { session: WorkspaceSessionView | null }) {
  const cycle = session?.cycles.at(-1);
  const fileCount = cycle?.workspaceDelta.comparisonBase === "cycle_start"
    ? cycle.workspaceDelta.fileCount
    : 0;
  return (
    <section className="environment-section">
      <header><span>运行环境</span></header>
      <div className="environment-row"><HardDrive size={15} /><span>本地 Runtime</span></div>
      <div className="environment-row"><FolderGit2 size={15} /><span>{session?.projectRoot ?? "尚未选择会话"}</span></div>
      <div className="environment-row"><GitBranch size={15} /><span>当前工作区</span></div>
      <div className="environment-row"><FileCode2 size={15} /><span>{fileCount} 个文件变更</span></div>
    </section>
  );
}
