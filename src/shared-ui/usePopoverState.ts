import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 受控弹层状态:统一「点触发按钮开合 + 点弹层外/按 Esc 关闭」。
 *
 * 必须同时排除 trigger 与 content:pointerdown 早于 click 触发,若不排除 trigger,
 * 点开按钮的那次 pointerdown 会被判为 outside 先把弹层关掉,紧随其后的 toggle 又把它
 * 打开,表现为「点按钮关不掉」。content 必须排除才不至于点选项/滚动时误关。
 *
 * 关闭后可选把焦点还给触发元素(restoreFocus),与 ProjectContextSelector 既有行为一致,
 * 方便键盘用户。document 监听仅在 open 时挂载,避免全局监听堆积。
 */
export function usePopoverState<
  TTrigger extends HTMLElement = HTMLElement,
  TContent extends HTMLElement = HTMLElement
>() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<TTrigger>(null);
  const contentRef = useRef<TContent>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const toggle = useCallback(() => setOpen((current) => !current), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return { open, triggerRef, contentRef, setOpen, toggle, close };
}
