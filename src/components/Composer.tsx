import { ArrowUp, ArrowUpDown, Check, ChevronDown, Mic, Plus, Shield, ShieldAlert, ShieldCheck, Square } from "lucide-react";
import { CSSProperties, FormEvent, useMemo, useState } from "react";
import { PermissionProfileKey } from "../../shared/runtimeTypes";
import { RuntimeConfig, RuntimeContextObserver } from "../runtimeClient";

const permissionOptions: Array<{ description: string; icon: typeof Shield; key: PermissionProfileKey; label: string }> = [
  { description: "外部访问和有风险的操作会先询问", icon: ShieldAlert, key: "request_approval", label: "请求批准" },
  { description: "仅在检测到高风险操作时询问", icon: ShieldCheck, key: "smart_approval", label: "智能审批" },
  { description: "允许访问网络并执行本机操作", icon: Shield, key: "full_access", label: "完全访问" }
];

export function Composer({
  contextConfig,
  contextObserver,
  isRunning,
  model,
  onCancel,
  onPermissionProfileChange,
  onSubmit,
  permissionProfile
}: {
  contextConfig: RuntimeConfig | null;
  contextObserver: RuntimeContextObserver | null;
  isRunning: boolean;
  model: string;
  onCancel: () => void;
  onPermissionProfileChange: (profile: PermissionProfileKey) => void;
  onSubmit: (prompt: string) => void;
  permissionProfile: PermissionProfileKey;
}) {
  const [draft, setDraft] = useState("");
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [contextSort, setContextSort] = useState<"protocol" | "tokens">("protocol");
  const [contextSortMenuOpen, setContextSortMenuOpen] = useState(false);
  const selectedPermission = permissionOptions.find((option) => option.key === permissionProfile) ?? permissionOptions[0];
  const SelectedPermissionIcon = selectedPermission.icon;
  const contextSummary = useMemo(() => {
    const latest = contextObserver?.latest ?? contextConfig?.contextPreview;
    const windowTokens = latest?.providerContextWindowTokens ?? contextConfig?.contextWindowTokens ?? 1_000_000;
    const used = latest?.actualInputTokens ?? latest?.estimatedInputTokens ?? 0;
    const sections = latest?.sections ?? [];
    const sum = (names: string[]) => sections.filter((section) => names.includes(section.section)).reduce((total, section) => total + section.estimatedTokens, 0);
    const protocolRows = [
      { color: "#1976f3", label: "工具定义", tokens: sum(["tools"]) },
      { color: "#5d8ff4", label: "系统提示", tokens: sum(["prompt_kernel"]) },
      { color: "#7ba7f7", label: "项目规范与环境", tokens: sum(["stable_session"]) },
      { color: "#9abcf8", label: "记忆与能力索引", tokens: sum(["memory_index", "capability_index"]) },
      { color: "#b7cdf7", label: "会话与工具结果", tokens: sum(["recent_history", "context_update", "recovery_capsule", "latest_user", "checkpoint"]) }
    ];
    const categorized = protocolRows.reduce((total, row) => total + row.tokens, 0);
    const rows = contextSort === "tokens" ? [...protocolRows].sort((left, right) => right.tokens - left.tokens) : protocolRows;
    const cacheUsage = (contextObserver?.recent ?? []).reduce((total, item) => ({
      hit: total.hit + (item.cacheHitTokens ?? 0),
      miss: total.miss + (item.cacheMissTokens ?? 0)
    }), { hit: 0, miss: 0 });
    const cacheTotal = cacheUsage.hit + cacheUsage.miss;
    return {
      cacheRate: cacheTotal > 0 ? cacheUsage.hit / cacheTotal : undefined,
      capabilitiesLoaded: contextObserver?.updates.filter((update) => update.kind === "capability").length ?? 0,
      compacted: latest?.compacted ?? false,
      compactThreshold: latest?.compactThresholdTokens ?? contextConfig?.compactThresholdTokens ?? 0,
      effectiveBudget: latest?.effectiveInputBudgetTokens ?? contextConfig?.effectiveInputBudgetTokens ?? 0,
      evidenceTrimmed: latest?.events?.filter((event) => event.kind === "evidence_truncated").length ?? 0,
      guidanceLoaded: contextObserver?.updates.filter((update) => update.kind === "path_guidance").length ?? 0,
      rows: rows.map((row) => ({ ...row, share: categorized > 0 ? row.tokens / categorized : 0 })),
      skillsLoaded: contextObserver?.updates.filter((update) => update.kind === "skill").length ?? 0,
      used,
      utilization: windowTokens > 0 ? Math.min(1, used / windowTokens) : 0,
      windowTokens
    };
  }, [contextConfig, contextObserver, contextSort]);
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
        <div className="composer-right">
          <div className="context-meter" tabIndex={0} aria-label="上下文用量">
            <span
              className="context-meter-ring"
              style={{ "--context-progress": `${Math.max(2, contextSummary.utilization * 100)}%` } as CSSProperties}
            />
            <div className="context-inspector-popover" role="tooltip">
              <header>
                <strong>上下文容量</strong>
                <div className="context-header-actions">
                  <span>{formatTokens(contextSummary.used)}/{formatTokens(contextSummary.windowTokens)} ({(contextSummary.utilization * 100).toFixed(1)}%)</span>
                  <button aria-label="上下文分类排序" onClick={() => setContextSortMenuOpen((open) => !open)} title="排序" type="button"><ArrowUpDown size={12} /></button>
                  {contextSortMenuOpen && (
                    <div className="context-sort-menu">
                      <button className={contextSort === "protocol" ? "is-selected" : ""} onClick={() => { setContextSort("protocol"); setContextSortMenuOpen(false); }} type="button">按上下文顺序</button>
                      <button className={contextSort === "tokens" ? "is-selected" : ""} onClick={() => { setContextSort("tokens"); setContextSortMenuOpen(false); }} type="button">按 Token 占比</button>
                    </div>
                  )}
                </div>
              </header>
              <div className="context-capacity-track"><span style={{ width: `${contextSummary.utilization * 100}%` }} /></div>
              <div className="context-category-list">
                {contextSummary.rows.map((row) => (
                  <div className="context-category-row" key={row.label}>
                    <span className="context-dot" style={{ background: row.color }} />
                    <span>{row.label}</span>
                    <strong>{(row.share * 100).toFixed(1)}%</strong>
                  </div>
                ))}
              </div>
              <div className="context-runtime-details">
                <span>本轮加载 <b>{contextSummary.guidanceLoaded}</b> 项规范 · <b>{contextSummary.skillsLoaded}</b> 个技能 · <b>{contextSummary.capabilitiesLoaded}</b> 个能力 · 裁剪 <b>{contextSummary.evidenceTrimmed}</b> 项证据</span>
                <span>有效预算 {formatTokens(contextSummary.effectiveBudget)} · 压缩阈值 {formatTokens(contextSummary.compactThreshold)}{contextSummary.compacted ? " · 已压缩" : ""}</span>
              </div>
              <footer><span>平均缓存命中率</span><strong>{contextSummary.cacheRate === undefined ? "尚无数据" : `${(contextSummary.cacheRate * 100).toFixed(1)}%`}</strong></footer>
            </div>
          </div>
          <button className="model-button" type="button"><span>{model}</span><ChevronDown size={13} /></button><button className="plain-icon" type="button" aria-label="语音输入"><Mic size={16} /></button>{isRunning ? <button className="send-button stop-button" onClick={onCancel} type="button" aria-label="停止"><Square size={14} /></button> : <button className="send-button" type="submit" aria-label="发送"><ArrowUp size={18} /></button>}
        </div>
      </div>
    </form>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
