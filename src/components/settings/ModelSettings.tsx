import { FormEvent, useEffect, useState } from "react";
import { DesktopSettings } from "../../../shared/contracts/desktop";
import { ModelOption, ModelProtocol } from "../../../shared/contracts/provider";
import { runtimeApi } from "../../runtimeApi";
import { desktopBridge, desktopErrorMessage } from "../../platform/desktop";

const DEFAULT_MODEL_PROTOCOLS: Record<string, ModelProtocol> = { "deepseek-v4-flash": "responses" };

function withProtocolDefaults(settings: DesktopSettings): DesktopSettings {
  return {
    ...settings,
    modelProtocols: { ...DEFAULT_MODEL_PROTOCOLS, ...(settings.modelProtocols ?? {}) }
  };
}

function protocolsFor(modelId: string, model?: ModelOption): ModelProtocol[] {
  if (model?.supportedProtocols?.length) return model.supportedProtocols;
  // A settings renderer can be newer than the currently running desktop
  // Runtime. Keep the known Flash capability selectable so saving the setting
  // can restart that Runtime with the new protocol metadata.
  return modelId === "deepseek-v4-flash" ? ["responses", "chat"] : ["chat"];
}

export function ModelSettings() {
  const desktop = desktopBridge();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [zhipuApiKey, setZhipuApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [requiresDesktopRestart, setRequiresDesktopRestart] = useState(false);

  useEffect(() => {
    void desktop?.settings.read().then((value) => {
      setRequiresDesktopRestart(value.modelProtocols === undefined);
      setSettings(withProtocolDefaults(value));
    }).catch((nextError) => {
      setError(desktopErrorMessage(nextError));
    });
  }, [desktop]);
  useEffect(() => {
    void runtimeApi.config().then((config) => setModels(config.models)).catch(() => undefined);
  }, []);
  const selectedModelId = settings?.defaultModel ?? "deepseek-v4-flash";
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const supportedProtocols = protocolsFor(selectedModelId, selectedModel);

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
        modelProtocols: settings?.modelProtocols ?? DEFAULT_MODEL_PROTOCOLS,
        zhipuApiKey: zhipuApiKey || undefined
      });
      runtimeApi.configure(result.connection);
      setSettings(withProtocolDefaults(result.settings));
      setRequiresDesktopRestart(false);
      setApiKey("");
      setZhipuApiKey("");
      setNotice("设置已保存，Runtime 已重新连接。");
    } catch (nextError) {
      setError(desktopErrorMessage(nextError));
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
            {(models.length > 0 ? models : [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" } as ModelOption])
              .map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
        <label className="settings-form-row">
          <span><strong>执行协议</strong><small>对该模型的新任务生效；历史任务保持原视图</small></span>
          <select
            disabled={!settings || supportedProtocols.length < 2}
            onChange={(event) => setSettings((current) => current ? {
              ...current,
              modelProtocols: { ...(current.modelProtocols ?? DEFAULT_MODEL_PROTOCOLS), [current.defaultModel]: event.target.value as ModelProtocol }
            } : current)}
            value={settings ? (settings.modelProtocols?.[settings.defaultModel]
              ?? selectedModel?.defaultProtocol
              ?? "chat") : "responses"}
          >
            {supportedProtocols.map((protocol) => (
              <option key={protocol} value={protocol}>{protocol === "responses" ? "Responses（语义执行流）" : "Chat Completions"}</option>
            ))}
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
        {requiresDesktopRestart && (
          <div className="settings-inline-error" role="alert">
            桌面主程序仍是旧版本，当前协议只显示了默认值，尚未传给 Runtime。请完全退出并重新打开应用后再保存。
          </div>
        )}
        {notice && <div className="settings-inline-notice">{notice}</div>}
        <footer><button className="settings-primary-action" disabled={saving} type="submit">{saving ? "正在保存" : "保存配置"}</button></footer>
      </form>
    </section>
  );
}
