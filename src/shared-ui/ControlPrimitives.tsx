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

type SidebarRowSharedProps = {
  actions?: ReactNode;
  actionsClassName?: string;
  leading?: ReactNode;
  shellClassName?: string;
  shellProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">;
};

function SidebarRowContent({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="sidebar-item-leading">{leading}</span>
      <span className="sidebar-item-copy">{children}</span>
    </>
  );
}

export function SidebarItemRow({
  actions,
  actionsClassName,
  children,
  className,
  leading,
  shellClassName,
  shellProps,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & SidebarRowSharedProps) {
  return (
    <div
      {...shellProps}
      className={classes("sidebar-item-row-shell", Boolean(actions) && "has-actions", shellClassName)}
    >
      <button
        {...props}
        className={classes("ui-row-action", "sidebar-item-row", className)}
        type={type}
      >
        <SidebarRowContent leading={leading}>{children}</SidebarRowContent>
      </button>
      {actions && <div className={classes("sidebar-item-actions", actionsClassName)}>{actions}</div>}
    </div>
  );
}

export function SidebarStaticRow({
  children,
  className,
  leading,
  ...props
}: HTMLAttributes<HTMLDivElement> & Pick<SidebarRowSharedProps, "leading">) {
  return (
    <div {...props} className={classes("sidebar-item-row-shell", "sidebar-static-row-shell", className)}>
      <div className="sidebar-item-row sidebar-static-row">
        <SidebarRowContent leading={leading}>{children}</SidebarRowContent>
      </div>
    </div>
  );
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
