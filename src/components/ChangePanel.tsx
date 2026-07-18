import { ChevronDown, FileCode2 } from "lucide-react";
import { useState } from "react";
import { FileChange, Changes } from "../../shared/contracts/runtime";

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "is-meta";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-delete";
  if (line.startsWith("@@")) return "is-hunk";
  return "";
}

function FileChangeRow({ file, onOpenFile }: { file: FileChange; onOpenFile: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasPatch = Boolean(file.patch?.trim());
  return (
    <div className={`patch-file ${expanded ? "is-expanded" : ""}`}>
      <div className="patch-row">
        <button className="file-reference-button" onClick={() => onOpenFile(file.path)} title={file.path} type="button">
          {file.path}
        </button>
        <strong><b>+{file.additions}</b> <i>-{file.deletions}</i></strong>
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"} ${file.path} diff`}
          className="patch-toggle"
          disabled={!hasPatch}
          onClick={() => hasPatch && setExpanded((value) => !value)}
          type="button"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {expanded && hasPatch && (
        <pre className="patch-diff" aria-label={`${file.path} diff`}>
          {file.patch!.split("\n").slice(0, 240).map((line, index) => (
            <code className={diffLineClass(line)} key={`${index}-${line.slice(0, 16)}`}>{line || " "}</code>
          ))}
        </pre>
      )}
    </div>
  );
}

export function ChangePanel({
  delta,
  onOpenFile,
  onOpenReview
}: {
  delta: Changes;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (delta.fileCount === 0 || delta.comparisonBase !== "run_start") return null;
  const visibleFiles = showAll ? delta.files : delta.files.slice(0, 3);
  const hiddenCount = Math.max(0, delta.files.length - visibleFiles.length);
  return (
    <section className="patch-card">
      <header>
        <button className="patch-card-review-trigger" onClick={() => onOpenReview(delta)} type="button">
          <FileCode2 size={17} />
          <strong>已更改 {delta.fileCount} 个文件</strong>
          <span><b>+{delta.additions}</b> <i>-{delta.deletions}</i></span>
        </button>
      </header>
      <div className="patch-list">
        {visibleFiles.map((file) => <FileChangeRow file={file} key={file.path} onOpenFile={onOpenFile} />)}
      </div>
      {hiddenCount > 0 && (
        <button className="show-more-files" onClick={() => setShowAll(true)} type="button">
          展开更多 {hiddenCount} 个文件
        </button>
      )}
      {showAll && delta.files.length > 3 && (
        <button className="show-more-files" onClick={() => setShowAll(false)} type="button">
          收起
        </button>
      )}
    </section>
  );
}
