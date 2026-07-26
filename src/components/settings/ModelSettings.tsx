import { FormEvent, useEffect, useState } from "react";
import { DesktopSettings } from "../../../shared/contracts/desktop";
import { runtimeApi } from "../../runtimeApi";
import { desktopBridge } from "../../platform/desktop";

export function ModelSettings() {
  const desktop = desktopBridge();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [zhipuApiKey, setZhipuApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void desktop?.settings.read().then(setSettings).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }, [desktop]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop) {
      setNotice("浏览器开发模式从 Runtime 环境读取模型配置。");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await desktop.settings.save({
        apiKey: apiKey || undefined,
        defaultModel: settings?.defaultModel ?? "deepseek-v4-flash",
        zhipuApiKey: zhipuApiKey || undefined
      });
      runtimeApi.configure(result.connection);
      setSettings(result.settings);
      setApiKey("");
      setZhipuApiKey("");
      setNotice("设置已保存，Runtime 已重新连接。");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <h1>模型与 API</h1>
        <p>凭据仅保存在本机。修改模型配置会重新启动 Runtime。</p>
      </header>
      <form className="settings-preference-section settings-model-form" onSubmit={(event) => void submit(event)}>
        <h2>模型服务</h2>
        <label className="settings-form-row">
          <span><strong>默认模型</strong><small>新任务默认使用的模型</small></span>
          <select
            disabled={!settings}
            onChange={(event) => setSettings((current) => current ? { ...current, defaultModel: event.target.value } : current)}
            value={settings?.defaultModel ?? "deepseek-v4-flash"}
          >
            <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
            <option value="deepseek-chat">DeepSeek Chat</option>
            <option value="deepseek-reasoner">DeepSeek Reasoner</option>
          </select>
        </label>
        <label className="settings-form-row">
          <span><strong>DeepSeek API Key</strong><small>{settings?.hasApiKey ? "已配置，留空保持不变" : "尚未配置"}</small></span>
          <input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? "已安全保存" : "输入 API Key"} type="password" value={apiKey} />
        </label>
        <label className="settings-form-row">
          <span><strong>智谱 API Key</strong><small>{settings?.hasZhipuApiKey ? "已配置，留空保持不变" : "可选"}</small></span>
          <input autoComplete="off" onChange={(event) => setZhipuApiKey(event.target.value)} placeholder={settings?.hasZhipuApiKey ? "已安全保存" : "输入 API Key"} type="password" value={zhipuApiKey} />
        </label>
        {error && <div className="settings-inline-error" role="alert">{error}</div>}
        {notice && <div className="settings-inline-notice">{notice}</div>}
        <footer><button className="settings-primary-action" disabled={saving} type="submit">{saving ? "正在保存" : "保存配置"}</button></footer>
      </form>
    </section>
  );
}
