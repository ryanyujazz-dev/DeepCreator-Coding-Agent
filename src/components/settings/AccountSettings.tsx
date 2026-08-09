import { Github, LogOut, Save, ShieldCheck, Trash2, WifiOff } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { AuthState, LocalProfileAvatar } from "../../../shared/contracts/auth";
import { ProfileAvatar, profileAvatarChoices } from "../../features/auth/ProfileAvatar";
import { desktopBridge, desktopErrorMessage } from "../../platform/desktop";
import { ConfirmationDialog } from "../ConfirmationDialog";

function dateLabel(value?: string): string {
  if (!value) return "当前会话";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function AccountSettings({ authState }: { authState?: AuthState }) {
  const desktop = desktopBridge();
  const localProfile = authState?.mode === "local";
  const [dialog, setDialog] = useState<"delete" | "signout" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileAvatar, setProfileAvatar] = useState<LocalProfileAvatar>(authState?.user?.avatar || "blue");
  const [profileName, setProfileName] = useState(authState?.user?.displayName || "本地 Profile");
  const [saved, setSaved] = useState(false);
  const user = authState?.user;
  useEffect(() => {
    setProfileAvatar(user?.avatar || "blue");
    setProfileName(user?.displayName || "本地 Profile");
  }, [user?.avatar, user?.displayName]);

  const saveLocalProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await desktop.auth.updateLocalProfile({ avatar: profileAvatar, displayName: profileName });
      setSaved(true);
    } catch (nextError) {
      setError(desktopErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };
  const execute = async () => {
    if (!desktop || !dialog) return;
    setBusy(true);
    setError(null);
    try {
      if (dialog === "delete") await desktop.auth.deleteAccount({ confirmation: "DELETE" });
      else await desktop.auth.signOut();
      setDialog(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-page account-settings-page">
      <header className="settings-page-header">
        <h1>{localProfile ? "本地 Profile" : "账号"}</h1>
        <p>{localProfile ? "这是这台设备上的独立工作身份，无需登录，也不会同步到云端。" : "管理登录身份、离线状态和这台电脑上的账号数据。"}</p>
      </header>
      <div className="settings-account-identity">
        {user?.avatarUrl
          ? <img alt="" referrerPolicy="no-referrer" src={user.avatarUrl} />
          : localProfile
            ? <ProfileAvatar avatar={user?.avatar} className="settings-account-avatar" displayName={user?.displayName || "本地 Profile"} />
            : <div className="settings-account-avatar">{user?.displayName.slice(0, 1).toLocaleUpperCase() || "D"}</div>}
        <div><strong>{user?.displayName || "本地 Profile"}</strong><span>{localProfile ? "仅此设备" : user ? `@${user.githubLogin}` : ""}</span></div>
        <div className={`settings-account-status is-${authState?.phase || "signed_out"}`}>
          {authState?.phase === "offline" ? <WifiOff size={14} /> : <ShieldCheck size={14} />}
          <span>{localProfile ? "已就绪" : authState?.phase === "offline" ? "离线登录" : "已验证"}</span>
        </div>
      </div>
      {localProfile && (
        <form className="settings-preference-section settings-profile-form" onSubmit={(event) => void saveLocalProfile(event)}>
          <h2>Profile 资料</h2>
          <label className="settings-form-row">
            <span><strong>显示名称</strong><small>最多 30 个字符，仅在这台设备显示。</small></span>
            <input disabled={busy} maxLength={30} onChange={(event) => { setProfileName(event.target.value); setSaved(false); }} value={profileName} />
          </label>
          <fieldset className="settings-profile-avatar-row">
            <legend><strong>头像</strong><small>选择一个本机预设头像。</small></legend>
            <div className="profile-avatar-options">
              {profileAvatarChoices.map((choice) => (
                <button
                  aria-label={choice.label}
                  aria-pressed={profileAvatar === choice.key}
                  disabled={busy}
                  key={choice.key}
                  onClick={() => { setProfileAvatar(choice.key); setSaved(false); }}
                  type="button"
                >
                  <ProfileAvatar avatar={choice.key} displayName={profileName} />
                </button>
              ))}
            </div>
          </fieldset>
          {error && <div className="settings-inline-error" role="alert">{error}</div>}
          {saved && <div className="settings-inline-notice" role="status">Profile 已保存。</div>}
          <footer><button className="settings-primary-action" disabled={busy || !profileName.trim()} type="submit"><Save size={14} />保存资料</button></footer>
        </form>
      )}
      <div className="settings-preference-section">
        <h2>{localProfile ? "身份" : "会话"}</h2>
        <div className="settings-preference-row">
          <div><strong>身份来源</strong><span>{localProfile ? "由 DeepCreator 在首次启动时创建并保存在这台设备上。" : "只读取 GitHub 公开身份，不申请仓库权限。"}</span></div>
          <span className="settings-readonly-value account-provider-value">{localProfile ? <ShieldCheck size={14} /> : <Github size={14} />}{localProfile ? "此设备" : "GitHub"}</span>
        </div>
        {localProfile ? (
          <div className="settings-preference-row">
            <div><strong>Profile ID</strong><span>用于隔离这台设备上的工作数据，不是公开账号。</span></div>
            <span className="settings-readonly-value account-provider-value">{user?.id || "准备中"}</span>
          </div>
        ) : (
          <div className="settings-preference-row">
            <div><strong>离线有效期</strong><span>联网时会自动刷新；到期后需要重新登录。</span></div>
            <span className="settings-readonly-value">{dateLabel(authState?.offlineUntil)}</span>
          </div>
        )}
      </div>
      <div className="settings-preference-section">
        <h2>本机数据</h2>
        <div className="settings-preference-row">
          <div><strong>Profile 隔离</strong><span>对话、最近项目、模型配置和 API Key 只保存在当前本地 Profile，不会上传。</span></div>
          <span className="settings-readonly-value">仅本机</span>
        </div>
        {!localProfile && (
          <div className="settings-account-actions">
            <button onClick={() => setDialog("signout")} type="button"><LogOut size={15} />退出登录</button>
            <button className="is-danger" onClick={() => setDialog("delete")} type="button"><Trash2 size={15} />注销账号</button>
          </div>
        )}
      </div>
      {!localProfile && dialog && (
        <ConfirmationDialog
          busy={busy}
          confirmLabel={dialog === "delete" ? "注销并移至废纸篓" : "退出登录"}
          danger={dialog === "delete"}
          description={dialog === "delete"
            ? "这会删除云端账号与全部会话，并把当前账号的 DeepCreator 本机对话、设置和凭据移入系统废纸篓。你的实际项目目录不会被删除。"
            : "退出后会停止当前 Agent Runtime，但保留这个账号的本机 Profile。"}
          error={error}
          onCancel={() => { if (!busy) { setDialog(null); setError(null); } }}
          onConfirm={() => void execute()}
          title={dialog === "delete" ? "注销 DeepCreator 账号？" : "退出当前账号？"}
        />
      )}
    </section>
  );
}
