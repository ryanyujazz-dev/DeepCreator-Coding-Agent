import { ConfirmationDialog } from "./ConfirmationDialog";

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
  return (
    <ConfirmationDialog
      busy={busy}
      confirmLabel={confirmLabel}
      danger
      description={description}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={title}
    />
  );
}
