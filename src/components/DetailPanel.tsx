import { ChevronRight, Code2, Copy } from "lucide-react";
import { ReactNode } from "react";
import { IconButton } from "../shared-ui/ControlPrimitives";

export function DetailPanel({
  children,
  className = "",
  collapsible = false,
  copyValue,
  expanded = true,
  meta,
  onTitleClick,
  onToggle,
  title
}: {
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  copyValue?: string;
  expanded?: boolean;
  meta?: ReactNode;
  onTitleClick?: () => void;
  onToggle?: () => void;
  title: string;
}) {
  return (
    <section className={`operation-detail-panel ${expanded ? "is-expanded" : ""} ${className}`.trim()}>
      <header onClick={() => collapsible && onToggle?.()}>
        <span aria-hidden="true" className="operation-detail-icon"><Code2 size={13} /></span>
        {onTitleClick ? (
          <button
            className="operation-detail-title is-interactive"
            onClick={(event) => {
              event.stopPropagation();
              onTitleClick();
            }}
            title={title}
            type="button"
          >
            {title}
          </button>
        ) : (
          <span className="operation-detail-title" title={title}>{title}</span>
        )}
        {meta}
        <span className="operation-detail-spacer" />
        {copyValue !== undefined && (
          <IconButton
            label={`复制 ${title}`}
            className="operation-detail-copy"
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard.writeText(copyValue);
            }}
            title="复制内容"
          >
            <Copy size={12} />
          </IconButton>
        )}
        {collapsible && <ChevronRight className="operation-detail-chevron" size={12} />}
      </header>
      <div className={`operation-detail-body ${expanded ? "is-expanded" : ""}`}>
        <div>{expanded && children}</div>
      </div>
    </section>
  );
}
