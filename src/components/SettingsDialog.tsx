import { KeyRound, Save, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { AuthState, LocalProfileAvatar } from "../../shared/contracts/auth";
import { DesktopSettings } from "../../shared/contracts/desktop";
import { ProfileAvatar, profileAvatarChoices } from "../features/auth/ProfileAvatar";
import { browserPlatform } from "../platform/browser";
import { desktopBridge, desktopErrorMessage } from "../platform/desktop";
import { PillButton, IconButton } from "../shared-ui/ControlPrimitives";

export function SettingsDialog({
  authState,
  onClose
}: {
  authState?: AuthState;
  onClose: () => void;
}) {
  const desktop = desktopBridge();
  const localProfile = authState?.mode === "local";
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [profileAvatar, setProfileAvatar] = useState<LocalProfileAvatar>(authState?.user?.avatar || "blue");
  const [profileName, setProfileName] = useState(authState?.user?.displayName || "本地 Profile");
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [zhipuApiKey, setZhipuApiKey] = useState("");

  useEffect(() => {
    setProfileAvatar(authState?.user?.avatar || "blue");
    setProfileName(authState?.user?.displayName || "本地 Profile");
  }, [authState?.user?.avatar, authState?.user?.displayName]);

  useEffect(() => {
    let active = true;
    void desktop?.settings.read().then((value) => {
      if (active) setSettings(value);
    }).catch((nextError: unknown) => {
      if (active) setError(desktopErrorMessage(nextError));
    });
    return () => { active = false; };
  }, [desktop]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop || !settings) return;
    setSaving(true);
    setError(null);
    try {
      if (localProfile) {
        await desktop.auth.updateLocalProfile({ avatar: profileAvatar, displayName: profileName });
      }
      await desktop.settings.save({
        apiKey: apiKey || undefined,
        defaultModel: settings.defaultModel,
        modelProtocols: settings.modelProtocols,
        zhipuApiKey: zhipuApiKey || undefined
      });
      browserPlatform.reload();
    } catch (nextError) {
      setError(desktopErrorMessage(nextError));
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <form aria-labelledby="compact-settings-title" aria-modal="true" className="settings-dialog compact-settings-dialog ui-floating-surface" onSubmit={(event) => void submit(event)} role="dialog">
        <header>
          <div><h2 id="compact-settings-title">个人与模型配置</h2><p>资料和凭据只保存在当前本地 Profile。</p></div>
          <IconButton disabled={saving} label="关闭配置" onClick={onClose}><X size={15} /></IconButton>
        </header>
        <div className="compact-settings-content">
          {localProfile && (
            <section className="compact-settings-section compact-profile-section">
              <div className="compact-settings-section-title"><UserRound size={15} /><div><h3>Profile</h3><p>修改左下角显示的名称和头像。</p></div></div>
              <label className="compact-settings-field">
                <span>显示名称</span>
                <input disabled={saving} maxLength={30} onChange={(event) => setProfileName(event.target.value)} value={profileName} />
              </label>
              <fieldset className="compact-settings-avatars">
                <legend>头像</legend>
                <div className="profile-avatar-options">
                  {profileAvatarChoices.map((choice) => (
                    <button
                      aria-label={choice.label}
                      aria-pressed={profileAvatar === choice.key}
                      disabled={saving}
                      key={choice.key}
                      onClick={() => setProfileAvatar(choice.key)}
                      type="button"
                    >
                      <ProfileAvatar avatar={choice.key} displayName={profileName} />
                    </button>
                  ))}
                </div>
              </fieldset>
            </section>
          )}
          <section className="compact-settings-section">
            <div className="compact-settings-section-title"><KeyRound size={15} /><div><h3>模型凭据</h3><p>凭据由系统加密存储，保存后 Runtime 会重新启动。</p></div></div>
            <label className="compact-settings-field">
              <span>DeepSeek API Key</span>
              <input autoComplete="off" disabled={saving || !settings} onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? "已保存，留空则保持不变" : "输入 DeepSeek API Key"} type="password" value={apiKey} />
            </label>
            <label className="compact-settings-field">
              <span>智谱 API Key</span>
              <input autoComplete="off" disabled={saving || !settings} onChange={(event) => setZhipuApiKey(event.target.value)} placeholder={settings?.hasZhipuApiKey ? "已保存，留空则保持不变" : "输入智谱 API Key（可选）"} type="password" value={zhipuApiKey} />
            </label>
          </section>
        </div>
        {error && <div className="settings-error" role="alert">{error}</div>}
        <footer>
          <PillButton disabled={saving} onClick={onClose}>取消</PillButton>
          <PillButton className="compact-settings-save" disabled={saving || !settings || (localProfile && !profileName.trim())} type="submit"><Save size={14} />{saving ? "正在保存" : "保存并重启"}</PillButton>
        </footer>
      </form>
    </div>
  );
}
