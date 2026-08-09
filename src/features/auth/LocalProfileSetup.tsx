import { LockKeyhole, Save, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { AuthUser, LocalProfileAvatar, LocalProfileInput } from "../../../shared/contracts/auth";
import { desktopErrorMessage } from "../../platform/desktop";
import { PillButton } from "../../shared-ui/ControlPrimitives";
import { ProfileAvatar, profileAvatarChoices } from "./ProfileAvatar";

export function LocalProfileSetup({
  onComplete,
  user
}: {
  onComplete: (input: LocalProfileInput) => Promise<void>;
  user: AuthUser;
}) {
  const [avatar, setAvatar] = useState<LocalProfileAvatar>(user.avatar || "blue");
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName === "本地 Profile" ? "" : user.displayName);
  const [error, setError] = useState<string | null>(null);

  const submit = async (input: LocalProfileInput) => {
    setBusy(true);
    setError(null);
    try {
      await onComplete(input);
    } catch (nextError) {
      setError(desktopErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit({ avatar, displayName });
  };

  return (
    <div className="auth-shell profile-setup-shell">
      <header className="auth-window-bar"><ShieldCheck size={15} /><strong>DeepCreator</strong><span>本地 Profile</span></header>
      <main className="auth-stage">
        <form className="auth-panel profile-setup-panel" onSubmit={onSubmit}>
          <div className="auth-kicker"><ShieldCheck size={16} /><span>首次使用</span></div>
          <h1>创建你的本地 Profile</h1>
          <p className="auth-introduction">设置一个在 DeepCreator 中显示的名称和头像。资料只保存在这台设备，之后可以随时修改。</p>
          <label className="profile-setup-field">
            <span>显示名称</span>
            <input
              aria-describedby="profile-name-hint"
              autoFocus
              disabled={busy}
              maxLength={30}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：George"
              value={displayName}
            />
            <small id="profile-name-hint">最多 30 个字符，仅用于本机界面显示。</small>
          </label>
          <fieldset className="profile-avatar-fieldset">
            <legend>选择头像</legend>
            <div className="profile-avatar-options">
              {profileAvatarChoices.map((choice) => (
                <button
                  aria-label={choice.label}
                  aria-pressed={avatar === choice.key}
                  disabled={busy}
                  key={choice.key}
                  onClick={() => setAvatar(choice.key)}
                  type="button"
                >
                  <ProfileAvatar avatar={choice.key} displayName={displayName} />
                </button>
              ))}
            </div>
          </fieldset>
          <div className="auth-status-line"><LockKeyhole size={16} /><span>不需要手机号或邮箱，不会上传个人资料</span></div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="auth-actions profile-setup-actions">
            <PillButton disabled={busy} onClick={() => void submit({ avatar: "blue", displayName: "本地 Profile" })}>暂时跳过</PillButton>
            <PillButton className="auth-primary-action" disabled={busy || !displayName.trim()} type="submit"><Save size={15} />开始使用</PillButton>
          </div>
          <footer><span>仅此设备</span><span>稍后可修改</span><span>无需联网</span></footer>
        </form>
      </main>
    </div>
  );
}
