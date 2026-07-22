import { X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { DesktopSettings } from "../../shared/contracts/desktop";
import { IconButton } from "../shared-ui/ControlPrimitives";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.deepseeker?.settings.read().then((value) => {
      setSettings(value);
      setModel(value.defaultModel);
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.deepseeker) return;
    setSaving(true);
    setError(null);
    try {
      await window.deepseeker.settings.save({ apiKey: apiKey || undefined, defaultModel: model });
      window.location.reload();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="settings-dialog ui-floating-surface" onSubmit={(event) => void submit(event)}>
        <header><div><h2>模型设置</h2><p>凭据由系统加密存储，保存后 Runtime 会重新启动。</p></div><IconButton label="关闭设置" onClick={onClose}><X size={15} /></IconButton></header>
        <label><span>默认模型</span><input onChange={(event) => setModel(event.target.value)} value={model} /></label>
        <label><span>DeepSeek API Key</span><input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? "已安全保存，留空则保持不变" : "输入 API Key"} type="password" value={apiKey} /></label>
        {error && <div className="settings-error">{error}</div>}
        <footer><button className="settings-cancel ui-dialog-button" onClick={onClose} type="button">取消</button><button className="settings-save ui-dialog-button is-primary" disabled={saving || !model.trim()} type="submit">{saving ? "正在保存" : "保存并重启"}</button></footer>
      </form>
    </div>
  );
}
