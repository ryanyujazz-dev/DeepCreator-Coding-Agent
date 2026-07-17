import { CheckSquare, Copy, FileCode2, GitPullRequest, Globe2, Maximize2, Minus, MoreHorizontal, PanelRight, Plus, X } from "lucide-react";
import { FileDeltaView } from "../../shared/runtimeTypes";
import { RuntimeFilePreview } from "../runtimeClient";

export type WorkspaceSurface =
  | { changedFiles?: FileDeltaView[]; file?: FileDeltaView; kind: "file"; path: string }
  | { kind: "browser"; title?: string; url: string };

function fileBreadcrumbs(file: RuntimeFilePreview): string[] {
  return file.path.split("/").filter(Boolean);
}

function FileSurface({
  changedFiles,
  error,
  file,
  fileDelta,
  loading
}: {
  changedFiles: FileDeltaView[];
  error: string | null;
  file: RuntimeFilePreview | null;
  fileDelta?: FileDeltaView;
  loading: boolean;
}) {
  const parts = file ? fileBreadcrumbs(file) : [];
  const lines = file?.content.split("\n") ?? [];
  if (fileDelta?.patch) {
    return <ReviewSurface changedFiles={changedFiles} file={file} fileDelta={fileDelta} notice={error} />;
  }
  if (loading) return <div className="surface-state">正在读取文件...</div>;
  if (error) return <div className="surface-state is-error">{error}</div>;
  if (!file) return <div className="surface-state">选择一个文件查看内容。</div>;
  return (
    <>
      <nav className="surface-breadcrumbs" aria-label="文件路径">
        {parts.map((part, index) => (
          <span key={`${index}-${part}`}>{part}</span>
        ))}
      </nav>
      <div className="surface-toolbar">
        <span>{file.truncated ? "内容已截断" : "只读预览"}</span>
        <button
          aria-label="复制文件内容"
          onClick={() => void navigator.clipboard?.writeText(file.content)}
          type="button"
        >
          <Copy size={13} />
        </button>
      </div>
      <pre className="surface-code">
        {lines.map((line, index) => (
          <code key={`${index}-${line.slice(0, 16)}`}>
            <span>{index + 1}</span>
            <b>{line || " "}</b>
          </code>
        ))}
      </pre>
    </>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "is-meta";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-delete";
  if (line.startsWith("@@")) return "is-hunk";
  return "";
}

function ReviewSurface({
  changedFiles,
  file,
  fileDelta,
  notice
}: {
  changedFiles: FileDeltaView[];
  file: RuntimeFilePreview | null;
  fileDelta: FileDeltaView;
  notice?: string | null;
}) {
  const files = changedFiles.length > 0 ? changedFiles : [fileDelta];
  const lines = fileDelta.patch!.split("\n").slice(0, 520);
  const copyText = file?.content ?? fileDelta.patch ?? "";
  return (
    <>
      <div className="surface-review-toolbar">
        <div>
          <strong>上一轮</strong>
          <span><b>+{files.reduce((sum, item) => sum + item.additions, 0)}</b> <i>-{files.reduce((sum, item) => sum + item.deletions, 0)}</i></span>
        </div>
        <div className="surface-review-actions">
          <button aria-label="更多审阅操作" type="button"><MoreHorizontal size={14} /></button>
          <button aria-label="审阅设置" type="button"><GitPullRequest size={14} /></button>
          <button aria-label="复制内容" onClick={() => void navigator.clipboard?.writeText(copyText)} type="button"><Copy size={14} /></button>
        </div>
      </div>
      {notice && <div className="surface-inline-notice">文件读取接口未生效，当前显示本轮 diff。重启 Runtime 后可查看完整文件。</div>}
      <div className="surface-review-files">
        {files.slice(0, 5).map((item) => (
          <div className={`surface-review-file ${item.path === fileDelta.path ? "is-active" : ""}`} key={item.path}>
            <FileCode2 size={13} />
            <span>{item.path}</span>
            <strong><b>+{item.additions}</b> <i>-{item.deletions}</i></strong>
          </div>
        ))}
      </div>
      <pre className="surface-diff" aria-label={`${fileDelta.path} diff`}>
        {lines.map((line, index) => (
          <code className={diffLineClass(line)} key={`${index}-${line.slice(0, 24)}`}>
            <span>{line.startsWith("@@") ? "" : index + 1}</span>
            <b>{line || " "}</b>
          </code>
        ))}
      </pre>
    </>
  );
}

function BrowserSurface({ surface }: { surface: Extract<WorkspaceSurface, { kind: "browser" }> }) {
  return (
    <div className="surface-state">
      <Globe2 size={15} />
      <span>{surface.url}</span>
    </div>
  );
}

export function WorkspaceSurfacePanel({
  file,
  fileError,
  fileLoading,
  isClosing = false,
  onClose,
  surface
}: {
  file: RuntimeFilePreview | null;
  fileError: string | null;
  fileLoading: boolean;
  isClosing?: boolean;
  onClose: () => void;
  surface: WorkspaceSurface | null;
}) {
  if (!surface) return null;
  const title = surface.kind === "file"
    ? surface.path.split("/").filter(Boolean).at(-1) ?? "文件"
    : surface.title ?? "浏览器";
  return (
    <aside className={`workspace-surface-panel ${isClosing ? "is-closing" : "is-open"}`} aria-label="工作区侧栏">
      <header className="surface-tab-strip">
        <div className="surface-tabs">
          <button className={`surface-tab ${surface.kind === "file" && !surface.file?.patch ? "is-active" : ""}`} type="button">
            <FileCode2 size={13} />
            <span>{surface.kind === "file" ? title : "文件"}</span>
            {surface.kind === "file" && !surface.file?.patch && <X size={12} />}
          </button>
          <button className={`surface-tab ${surface.kind === "file" && surface.file?.patch ? "is-active" : ""}`} type="button">
            <CheckSquare size={13} />
            <span>审阅</span>
            {surface.kind === "file" && surface.file?.patch && <X size={12} />}
          </button>
        </div>
        <div className="surface-window-actions">
          <button aria-label="新建标签" type="button"><Plus size={14} /></button>
          <button aria-label="展开工作区" type="button"><Maximize2 size={13} /></button>
          <button aria-label="最小化工作区" type="button"><Minus size={14} /></button>
          <button aria-label="切换侧栏布局" type="button"><PanelRight size={14} /></button>
          <button aria-label="关闭工作区侧栏" onClick={onClose} type="button"><X size={14} /></button>
        </div>
      </header>
      {surface.kind === "file"
        ? <FileSurface changedFiles={surface.changedFiles ?? []} error={fileError} file={file} fileDelta={surface.file} loading={fileLoading} />
        : <BrowserSurface surface={surface} />}
    </aside>
  );
}
