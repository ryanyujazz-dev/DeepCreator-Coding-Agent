import { X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { DesktopSettings } from "../../shared/contracts/desktop";
import { IconButton } from "../shared-ui/ControlPrimitives";
import { browserPlatform } from "../platform/browser";
import { desktopBridge, desktopErrorMessage } from "../platform/desktop";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const desktop = desktopBridge();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [zhipuApiKey, setZhipuApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void desktop?.settings.read().then((value) => {
      setSettings(value);
    });
  }, [desktop]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop) return;
    setSaving(true);
    setError(null);
    try {
      await desktop.settings.save({
        apiKey: apiKey || undefined,
        defaultModel: settings?.defaultModel ?? "deepseek-v4-flash",
        modelProtocols: settings?.modelProtocols ?? { "deepseek-v4-flash": "responses" },
        zhipuApiKey: zhipuApiKey || undefined
      });
      browserPlatform.reload();
    } catch (nextError) {
      setError(desktopErrorMessage(nextError));
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="settings-dialog ui-floating-surface" onSubmit={(event) => void submit(event)}>
        <header><div><h2>API 设置</h2><p>凭据由系统加密存储，保存后 Runtime 会重新启动。</p></div><IconButton label="关闭设置" onClick={onClose}><X size={15} /></IconButton></header>
        <label><span>DeepSeek API Key</span><input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? "已保存，留空则保持不变" : "输入 DeepSeek API Key"} type="password" value={apiKey} /></label>
        <label><span>智谱 API Key</span><input autoComplete="off" onChange={(event) => setZhipuApiKey(event.target.value)} placeholder={settings?.hasZhipuApiKey ? "已保存，留空则保持不变" : "输入智谱 API Key（可选）"} type="password" value={zhipuApiKey} /></label>
        {error && <div className="settings-error">{error}</div>}
        <footer><button className="settings-cancel ui-dialog-button" onClick={onClose} type="button">取消</button><button className="settings-save ui-dialog-button is-primary" disabled={saving} type="submit">{saving ? "正在保存" : "保存并重启"}</button></footer>
      </form>
    </div>
  );
}
