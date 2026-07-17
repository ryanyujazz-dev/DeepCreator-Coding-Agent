import { ArrowUp, Check, ChevronDown, Mic, Plus, Shield, ShieldAlert, ShieldCheck, Square } from "lucide-react";
import { FormEvent, useState } from "react";
import { PermissionProfileKey } from "../../shared/runtimeTypes";

const permissionOptions: Array<{ description: string; icon: typeof Shield; key: PermissionProfileKey; label: string }> = [
  { description: "外部访问和有风险的操作会先询问", icon: ShieldAlert, key: "request_approval", label: "请求批准" },
  { description: "仅在检测到高风险操作时询问", icon: ShieldCheck, key: "smart_approval", label: "智能审批" },
  { description: "允许访问网络并执行本机操作", icon: Shield, key: "full_access", label: "完全访问" }
];

export function Composer({
  isRunning,
  model,
  onCancel,
  onPermissionProfileChange,
  onSubmit,
  permissionProfile
}: {
  isRunning: boolean;
  model: string;
  onCancel: () => void;
  onPermissionProfileChange: (profile: PermissionProfileKey) => void;
  onSubmit: (prompt: string) => void;
  permissionProfile: PermissionProfileKey;
}) {
  const [draft, setDraft] = useState("");
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const selectedPermission = permissionOptions.find((option) => option.key === permissionProfile) ?? permissionOptions[0];
  const SelectedPermissionIcon = selectedPermission.icon;
  function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || isRunning) return;
    setDraft("");
    onSubmit(prompt);
  }
  return (
    <form className="composer" onSubmit={submit}>
      <textarea aria-label="输入任务" disabled={isRunning} onChange={(event) => setDraft(event.target.value)} placeholder={isRunning ? "Agent 正在处理" : "随心输入"} value={draft} />
      <div className="composer-row">
        <div className="composer-left">
          <button className="plain-icon" type="button" aria-label="添加上下文"><Plus size={20} /></button>
          <div className="permission-selector">
            <button className="access-button" type="button" aria-expanded={permissionMenuOpen} onClick={() => setPermissionMenuOpen((open) => !open)}>
              <SelectedPermissionIcon size={15} /><span>{selectedPermission.label}</span><ChevronDown size={13} />
            </button>
            {permissionMenuOpen && (
              <div className="permission-menu" role="menu">
                {permissionOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      className={option.key === permissionProfile ? "is-selected" : ""}
                      key={option.key}
                      onClick={() => {
                        onPermissionProfileChange(option.key);
                        setPermissionMenuOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon size={16} />
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      {option.key === permissionProfile && <Check size={15} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="composer-right"><button className="model-button" type="button"><span>{model}</span><ChevronDown size={13} /></button><button className="plain-icon" type="button" aria-label="语音输入"><Mic size={16} /></button>{isRunning ? <button className="send-button stop-button" onClick={onCancel} type="button" aria-label="停止"><Square size={14} /></button> : <button className="send-button" type="submit" aria-label="发送"><ArrowUp size={18} /></button>}</div>
      </div>
    </form>
  );
}
