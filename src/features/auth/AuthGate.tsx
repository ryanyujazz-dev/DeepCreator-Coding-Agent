import { Github, LoaderCircle, RotateCcw, ShieldCheck, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { AuthState } from "../../../shared/contracts/auth";
import { PillButton } from "../../shared-ui/ControlPrimitives";

export function AuthGate({
  onCancel,
  onRetry,
  onSignIn,
  state
}: {
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
  onSignIn: () => Promise<void>;
  state: AuthState;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const local = state.mode === "local";
  const authorizing = state.phase === "authorizing";
  const checking = state.phase === "checking";
  return (
    <div className="auth-shell">
      <header className="auth-window-bar"><ShieldCheck size={15} /><strong>DeepCreator</strong><span>{local ? "本机工作区" : "账号验证"}</span></header>
      <main className="auth-stage">
        <section aria-busy={busy || checking} className="auth-panel">
          <div className="auth-kicker"><ShieldCheck size={16} /><span>{local ? "本地 Profile" : "本机工作区保护"}</span></div>
          <h1>{local
            ? checking ? "正在准备本地工作区" : "本地工作区启动失败"
            : authorizing ? "在浏览器中完成授权" : checking ? "正在恢复账号" : "登录 DeepCreator"}</h1>
          <p className="auth-introduction">
            {local
              ? checking
                ? "正在载入这台电脑上的 Profile 并启动 Agent Runtime。"
                : "本地 Profile 已准备好，但 Agent Runtime 未能启动。可以直接重试，不需要登录或联网。"
              : authorizing
              ? "GitHub 授权完成后，DeepCreator 会自动继续。此窗口不会读取你的仓库权限。"
              : checking
                ? "正在校验加密会话与离线凭证。"
                : "首次登录需要联网。项目、对话、Skills 和模型密钥仍保存在这台电脑。"}
          </p>
          <div className="auth-status-line">
            {local
              ? checking
                ? <><LoaderCircle className="auth-spinner" size={16} /><span>载入本机数据</span></>
                : <><RotateCcw size={16} /><span>等待重新启动本机 Runtime</span></>
              : authorizing || checking
              ? <><LoaderCircle className="auth-spinner" size={16} /><span>{authorizing ? "等待 GitHub 返回授权结果" : "检查账号状态"}</span></>
              : state.phase === "expired"
                ? <><WifiOff size={16} /><span>离线凭证已过期，需要重新登录</span></>
                : <><Github size={16} /><span>使用 GitHub 公开身份登录</span></>}
          </div>
          {(localError || state.detail) && <div className="auth-error" role="alert">{localError || state.detail}</div>}
          <div className="auth-actions">
            {local ? (
              state.phase === "error" && <PillButton disabled={busy} onClick={() => void run(onRetry)}><RotateCcw size={15} />重新启动</PillButton>
            ) : authorizing ? (
              <PillButton disabled={busy} onClick={() => void run(onCancel)}><X size={15} />取消授权</PillButton>
            ) : (
              <PillButton className="auth-primary-action" disabled={busy || checking} onClick={() => void run(onSignIn)}>
                <Github size={16} />使用 GitHub 登录
              </PillButton>
            )}
            {!local && (state.phase === "error" || state.phase === "expired") && (
              <PillButton disabled={busy} onClick={() => void run(onRetry)}><RotateCcw size={15} />重新检查</PillButton>
            )}
          </div>
          <footer>
            {local
              ? <><span>无需登录</span><span>数据仅存本机</span><span>安装后直接使用</span></>
              : <><span>30 天离线使用</span><span>账号间本机隔离</span><span>不申请仓库权限</span></>}
          </footer>
        </section>
      </main>
    </div>
  );
}
