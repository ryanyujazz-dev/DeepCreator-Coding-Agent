import {
  CircleArrowUp,
  Download,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X
} from "lucide-react";
import { CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppUpdatePhase, AppUpdateState } from "../../../shared/contracts/update";
import { desktopBridge, desktopErrorMessage } from "../../platform/desktop";
import { FloatingSurface, IconButton, PillButton } from "../../shared-ui/ControlPrimitives";
import { usePopoverState } from "../../shared-ui/usePopoverState";

function triggerLabel(phase: AppUpdatePhase): string {
  if (phase === "ready") return "有可用更新";
  if (phase === "installing") return "正在安装更新";
  if (phase === "downloading") return "正在下载更新";
  if (phase === "checking") return "正在检查更新";
  if (phase === "error") return "更新检查失败";
  return "检查应用更新";
}

function updateIcon(phase: AppUpdatePhase) {
  if (phase === "ready" || phase === "installing") return <CircleArrowUp size={15} />;
  if (phase === "downloading") return <Download size={15} />;
  if (phase === "checking") return <LoaderCircle className="app-update-spinner" size={15} />;
  if (phase === "error") return <TriangleAlert size={15} />;
  return <RefreshCw size={15} />;
}

function updateMessage(state: AppUpdateState): { detail: string; title: string } {
  if (state.phase === "checking") return { detail: "正在连接发布服务并比较版本。", title: "正在检查更新" };
  if (state.phase === "downloading") return { detail: "新版本正在后台下载，完成后即可重启安装。", title: "正在下载更新" };
  if (state.phase === "ready") return { detail: "更新已经安全下载，可以立即重启并完成安装。", title: "更新已准备好" };
  if (state.phase === "installing") return { detail: "正在结束本地 Runtime，随后会重启 DeepCreator。", title: "正在安装更新" };
  if (state.phase === "error") return { detail: state.detail || "暂时无法连接更新服务，请稍后重试。", title: "更新检查失败" };
  if (state.phase === "current") return { detail: "当前安装版本已经是最新版本。", title: "已是最新版本" };
  return { detail: "DeepCreator 会定期检查公开发布的新版本。", title: "应用更新" };
}

function popoverPosition(element: HTMLElement): CSSProperties {
  const rect = element.getBoundingClientRect();
  const width = 328;
  const height = 240;
  return {
    left: Math.max(8, Math.min(rect.right + 10, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(rect.bottom - height, window.innerHeight - height - 8))
  };
}

export function AppUpdateControl() {
  const desktop = desktopBridge();
  const popover = usePopoverState<HTMLButtonElement, HTMLDivElement>();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const unsubscribe = desktop.updates.onState((nextState) => {
      if (active) setState(nextState);
    });
    void desktop.updates.getState().then((nextState) => {
      if (active) setState(nextState);
    }).catch((error: unknown) => {
      if (active) setActionError(desktopErrorMessage(error));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  if (!desktop || !state?.supported) return null;
  const message = updateMessage(state);
  const active = ["downloading", "ready", "installing", "error"].includes(state.phase);

  const toggle = () => {
    setActionError(null);
    if (!popover.open && popover.triggerRef.current) setPosition(popoverPosition(popover.triggerRef.current));
    popover.toggle();
  };

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      setState(await desktop.updates.check());
    } catch (error) {
      setActionError(desktopErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      setState(await desktop.updates.install());
    } catch (error) {
      setActionError(desktopErrorMessage(error));
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton
        aria-expanded={popover.open}
        aria-haspopup="dialog"
        className={`app-update-trigger ${active ? "is-active" : ""} is-${state.phase}`}
        label={triggerLabel(state.phase)}
        onClick={toggle}
        ref={popover.triggerRef}
      >
        {updateIcon(state.phase)}
      </IconButton>
      {popover.open && createPortal(
        <FloatingSurface
          aria-label="应用更新"
          className="app-update-popover"
          ref={popover.contentRef}
          role="dialog"
          style={position}
        >
          <header>
            <div className={`app-update-status-icon is-${state.phase}`}>{updateIcon(state.phase)}</div>
            <div><strong>{message.title}</strong><span>当前版本 v{state.currentVersion}</span></div>
            <IconButton label="关闭更新信息" onClick={() => popover.close(true)}><X size={14} /></IconButton>
          </header>
          <div className="app-update-popover-body">
            {state.availableVersion && <div className="app-update-version">可用版本<strong>{state.availableVersion}</strong></div>}
            <p>{message.detail}</p>
            {state.phase === "ready" && state.releaseNotes && <p className="app-update-release-notes">{state.releaseNotes}</p>}
            {actionError && <div className="app-update-error" role="alert">{actionError}</div>}
          </div>
          <footer>
            {state.phase === "ready" ? (
              <>
                <PillButton disabled={busy} onClick={() => popover.close(true)}>稍后</PillButton>
                <PillButton className="app-update-primary" disabled={busy} onClick={() => void install()}>
                  <CircleArrowUp size={14} />重启并更新
                </PillButton>
              </>
            ) : (
              <>
                <span>{state.checkedAt ? `上次检查 ${new Date(state.checkedAt).toLocaleString()}` : "自动检查已开启"}</span>
                <PillButton
                  disabled={busy || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing"}
                  onClick={() => void check()}
                >
                  <RefreshCw className={state.phase === "checking" ? "app-update-spinner" : ""} size={14} />检查更新
                </PillButton>
              </>
            )}
          </footer>
        </FloatingSurface>,
        document.body
      )}
    </>
  );
}
