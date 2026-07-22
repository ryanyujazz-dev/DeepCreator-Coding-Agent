import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function SidebarConfirmationDialog({
  busy,
  confirmLabel,
  description,
  error,
  onCancel,
  onConfirm,
  title
}: {
  busy: boolean;
  confirmLabel: string;
  description: string;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
}) {
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  const titleId = useId();
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("[data-safe-focus]")?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="sidebar-dialog-backdrop"
      onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}
    >
      <div
        aria-busy={busy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="sidebar-confirm-dialog"
        ref={dialogRef}
        role="alertdialog"
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button aria-label="关闭警示弹窗" disabled={busy} onClick={onCancel} type="button"><X size={19} /></button>
        </header>
        <p id={descriptionId}>{description}</p>
        {error && <div className="sidebar-confirm-error" role="alert">{error}</div>}
        <footer>
          <button data-safe-focus disabled={busy} onClick={onCancel} type="button">取消</button>
          <button className="is-danger" disabled={busy} onClick={onConfirm} type="button">
            {busy ? "处理中..." : confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
