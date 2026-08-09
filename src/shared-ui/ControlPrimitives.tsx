import {
  ButtonHTMLAttributes,
  forwardRef,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode
} from "react";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function IconButton({ className, label, title, type = "button", ...props }, ref) {
    return (
      <button
        {...props}
        aria-label={props["aria-label"] ?? label}
        className={classes("ui-icon-button", className)}
        ref={ref}
        title={title ?? label}
        type={type}
      />
    );
  }
);

export const PillButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PillButton({ className, type = "button", ...props }, ref) {
    return <button {...props} className={classes("ui-pill-button", className)} ref={ref} type={type} />;
  }
);

export function RowAction({
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={classes("ui-row-action", className)} type={type} />;
}

export const FloatingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FloatingSurface({ className, ...props }, ref) {
    return <div {...props} className={classes("ui-floating-surface", className)} ref={ref} />;
  }
);

export function DisclosureRow({
  children,
  className,
  expanded,
  onKeyDown,
  onToggle,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown"> & {
  children: ReactNode;
  expanded: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onToggle: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div
      {...props}
      aria-expanded={expanded}
      className={classes("ui-disclosure-row", className)}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
