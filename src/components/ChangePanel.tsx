import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { Changes } from "../../shared/contracts/runtime";
import { fileDisplayName } from "../../shared/projections/activityPresentation";
import { PillButton, RowAction } from "../shared-ui/ControlPrimitives";

export function ChangePanel({
  delta,
  onOpenFile,
  onOpenReview
}: {
  delta: Changes;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (delta.fileCount === 0 || delta.comparisonBase !== "run_start") return null;
  return (
    <section className={`patch-card ${expanded ? "is-expanded" : ""}`}>
      <header className="patch-card-header">
        <RowAction
          aria-controls={listId}
          aria-expanded={expanded}
          className="patch-card-disclosure"
          onClick={() => setExpanded((value) => !value)}
        >
          <strong>变更 {delta.fileCount} 个文件</strong>
          <span className="patch-card-stats"><b>+{delta.additions}</b> <i>-{delta.deletions}</i></span>
          <ChevronRight aria-hidden="true" className="patch-card-chevron" size={14} />
        </RowAction>
        <PillButton className="patch-card-review-button" onClick={() => onOpenReview(delta)}>
          审阅
        </PillButton>
      </header>
      {expanded && (
        <div aria-label="变更文件" className="patch-list" id={listId}>
          {delta.files.map((file) => (
            <div className="patch-file" key={file.path}>
              <RowAction className="patch-row" onClick={() => onOpenFile(file.path)} title={file.path}>
                <span className="patch-file-name">{fileDisplayName(file.path)}</span>
                <strong><b>+{file.additions}</b> <i>-{file.deletions}</i></strong>
              </RowAction>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
