import { ArrowRight, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Lightbulb, Mic, PencilLine, Plus, Shield, ShieldAlert, ShieldCheck, Square, X } from "lucide-react";
import { CSSProperties, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessMode, Mode, Plan, PlanDecision, Question } from "../../shared/contracts/runtime";
import { ModelOption } from "../../shared/contracts/provider";
import { RuntimeBalance, RuntimeConfig, RuntimeContextObserver } from "../runtimeApi";
import { FloatingSurface, IconButton, PillButton } from "../shared-ui/ControlPrimitives";

const accessOptions: Array<{ description: string; icon: typeof Shield; key: AccessMode; label: string }> = [
  { description: "外部访问和有风险的操作会先询问", icon: ShieldAlert, key: "request_approval", label: "请求批准" },
  { description: "仅在检测到高风险操作时询问", icon: ShieldCheck, key: "smart_approval", label: "智能审批" },
  { description: "允许访问网络并执行本机操作", icon: Shield, key: "full_access", label: "完全访问" }
];

export function Composer({
  balance,
  contextConfig,
  contextObserver,
  disabledReason,
  isRunning,
  isWaiting,
  model,
  models,
  onCancel,
  onAccessModeChange,
  onModeChange,
  onAnswerQuestion,
  onModelChange,
  onRefreshBalance,
  onResolvePlan,
  onSubmit,
  resetKey,
  pendingPlan,
  pendingQuestion,
  accessMode,
  mode
}: {
  balance?: RuntimeBalance | null;
  contextConfig: RuntimeConfig | null;
  contextObserver: RuntimeContextObserver | null;
  disabledReason?: string;
  isRunning: boolean;
  isWaiting: boolean;
  model: string;
  models: ModelOption[];
  onCancel: () => void;
  onAccessModeChange: (mode: AccessMode) => void;
  onModeChange: (mode: Mode) => void;
  onAnswerQuestion: (interactionId: string, answers: Record<string, string>) => Promise<void> | void;
  onModelChange: (model: string) => void;
  onRefreshBalance: () => void;
  onResolvePlan: (plan: Plan, decision: PlanDecision, comments?: string, nextAccessMode?: AccessMode) => Promise<void> | void;
  onSubmit: (prompt: string) => Promise<boolean>;
  pendingPlan?: Plan;
  pendingQuestion?: Question;
  resetKey: string | number;
  accessMode: AccessMode;
  mode: Mode;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // textarea 自适应高度:初始 2 行,随内容增长最高到 8 行,超过 8 行内部滚动。
  // CSS 里 min-height/max-height 已经把范围限定到 2~8 行,JS 只需根据 scrollHeight 设置 height。
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const COMPOSER_MIN_HEIGHT = 78;   // ≈ 2 行(2 × 22.5 行高 + 30 padding)
  const COMPOSER_MAX_HEIGHT = 210;  // ≈ 8 行(8 × 22.5 + 30)
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // 先重置为 auto,让 scrollHeight 反映真实内容高度(否则 height 会卡在上次值)
    el.style.height = "auto";
    const next = Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${next}px`;
  }, []);
  useEffect(() => {
    autoGrow();
  }, [draft, autoGrow]);
  useEffect(() => {
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = `${COMPOSER_MIN_HEIGHT}px`;
  }, [resetKey]);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextSort, setContextSort] = useState<"protocol" | "tokens">("protocol");
  const [contextSortMenuOpen, setContextSortMenuOpen] = useState(false);
  const [comments, setComments] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const selectedAccess = accessOptions.find((option) => option.key === accessMode) ?? accessOptions[0];
  const SelectedAccessIcon = selectedAccess.icon;
  useEffect(() => {
    setComments("");
  }, [pendingPlan?.planId, pendingPlan?.revision]);
  useEffect(() => {
    setAnswers({});
    setQuestionIndex(0);
  }, [pendingQuestion?.interactionId]);
  const contextSummary = useMemo(() => {
    const latest = contextObserver?.latest ?? contextConfig?.contextPreview;
    const windowTokens = latest?.providerContextWindowTokens ?? contextConfig?.contextWindowTokens ?? 1_000_000;
    const used = latest?.actualInputTokens ?? latest?.estimatedInputTokens ?? 0;
    const sections = latest?.sections ?? [];
    const sum = (names: string[]) => sections.filter((section) => names.includes(section.section)).reduce((total, section) => total + section.estimatedTokens, 0);
    const protocolRows = [
      { color: "var(--context-segment-tools)", label: "工具定义", tokens: sum(["tools"]) },
      { color: "var(--context-segment-system)", label: "系统提示", tokens: sum(["prompt_kernel"]) },
      { color: "var(--context-segment-project)", label: "项目规范与环境", tokens: sum(["stable_session"]) },
      { color: "var(--context-segment-memory)", label: "记忆与能力索引", tokens: sum(["memory_index", "capability_index"]) },
      { color: "var(--context-segment-history)", label: "会话与工具结果", tokens: sum(["recent_history", "context_update", "recovery_capsule", "latest_user", "checkpoint"]) }
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
  async function sendDraft() {
    const prompt = draft.trim();
    if (!prompt || isRunning || isWaiting || disabledReason || submitting) return;
    setSubmitting(true);
    try {
      const succeeded = await onSubmit(prompt);
      if (!succeeded) return;
      setDraft("");
      if (textareaRef.current) textareaRef.current.style.height = `${COMPOSER_MIN_HEIGHT}px`;
    } finally {
      setSubmitting(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void sendDraft();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送,Shift+Enter 换行;Cmd/Ctrl+Enter 不触发(留给未来可能的强制发送)
    // 中文/日文输入法用 Enter 确认候选词时不能提交当前草稿。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      void sendDraft();
    }
  }
  const resolvePlan = async (decision: PlanDecision) => {
    if (!pendingPlan || interactionBusy) return;
    setInteractionBusy(true);
    try {
      await onResolvePlan(pendingPlan, decision, comments, decision === "start_work" ? accessMode : undefined);
    } finally {
      setInteractionBusy(false);
    }
  };
  const submitAnswers = async () => {
    if (!pendingQuestion || interactionBusy || pendingQuestion.prompts.some((prompt) => !answers[prompt.questionId]?.trim())) return;
    setInteractionBusy(true);
    try {
      await onAnswerQuestion(pendingQuestion.interactionId, answers);
    } finally {
      setInteractionBusy(false);
    }
  };

  if (pendingPlan) {
    return (
      <form className="composer interaction-composer plan-review-composer" onSubmit={(event) => event.preventDefault()}>
        <header className="interaction-header">
          <strong>实施此计划？</strong>
          <IconButton disabled={interactionBusy} label="取消计划" onClick={() => void resolvePlan("cancel")}><X size={14} /></IconButton>
        </header>
        <button className="interaction-primary-row" disabled={interactionBusy} onClick={() => void resolvePlan("start_work")} type="button">
          <span className="interaction-number">1</span>
          <strong>是，实施此计划</strong>
          <ArrowRight size={15} />
        </button>
        <div className="interaction-feedback-row">
          <span className="interaction-number"><PencilLine size={13} /></span>
          <textarea aria-label="计划调整意见" onChange={(event) => setComments(event.target.value)} placeholder="否，并告诉 Agent 应该如何调整" value={comments} />
          <button disabled={interactionBusy} onClick={() => void resolvePlan("continue_planning")} type="button">继续规划</button>
        </div>
        <footer className="interaction-footer">
          <div className="permission-selector">
            <PillButton className="access-button" aria-expanded={accessMenuOpen} onClick={() => setAccessMenuOpen((open) => !open)}>
              <SelectedAccessIcon size={15} /><span>{selectedAccess.label}</span><ChevronDown size={13} />
            </PillButton>
            {accessMenuOpen && (
              <FloatingSurface className="permission-menu" role="menu">
                {accessOptions.map((option) => {
                  const Icon = option.icon;
                  return <button className={option.key === accessMode ? "is-selected" : ""} key={option.key} onClick={() => { onAccessModeChange(option.key); setAccessMenuOpen(false); }} role="menuitem" type="button"><Icon size={16} /><span><strong>{option.label}</strong><small>{option.description}</small></span>{option.key === accessMode && <Check size={15} />}</button>;
                })}
              </FloatingSurface>
            )}
          </div>
          <button disabled={interactionBusy} onClick={() => void resolvePlan("cancel")} type="button">取消计划</button>
        </footer>
      </form>
    );
  }

  if (pendingQuestion) {
    const prompt = pendingQuestion.prompts[questionIndex] ?? pendingQuestion.prompts[0];
    const complete = pendingQuestion.prompts.every((item) => answers[item.questionId]?.trim());
    return (
      <form className="composer interaction-composer question-composer" onSubmit={(event) => { event.preventDefault(); void submitAnswers(); }}>
        <header className="interaction-header">
          <strong>{prompt.prompt}</strong>
          {pendingQuestion.prompts.length > 1 && <div className="question-pagination"><IconButton disabled={questionIndex === 0} label="上一项" onClick={() => setQuestionIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={13} /></IconButton><span>{questionIndex + 1} of {pendingQuestion.prompts.length}</span><IconButton disabled={questionIndex === pendingQuestion.prompts.length - 1} label="下一项" onClick={() => setQuestionIndex((value) => Math.min(pendingQuestion.prompts.length - 1, value + 1))}><ChevronRight size={13} /></IconButton></div>}
        </header>
        {prompt.options?.map((option, index) => (
          <button className={`interaction-option-row ${answers[prompt.questionId] === option ? "is-selected" : ""}`} key={option} onClick={() => setAnswers((current) => ({ ...current, [prompt.questionId]: option }))} type="button">
            <span className="interaction-number">{index + 1}</span><span>{option}</span>{answers[prompt.questionId] === option ? <Check size={14} /> : <ArrowRight size={14} />}
          </button>
        ))}
        {!prompt.options?.length && <div className="interaction-feedback-row"><span className="interaction-number"><PencilLine size={13} /></span><textarea aria-label={prompt.label} onChange={(event) => setAnswers((current) => ({ ...current, [prompt.questionId]: event.target.value }))} placeholder={prompt.label} value={answers[prompt.questionId] ?? ""} /></div>}
        <footer className="interaction-footer"><span>{pendingQuestion.prompts.length > 1 ? `已回答 ${Object.values(answers).filter((value) => value.trim()).length}/${pendingQuestion.prompts.length}` : ""}</span><button className="interaction-submit" disabled={interactionBusy || !complete} type="submit">提交回答</button></footer>
      </form>
    );
  }
  return (
    <form aria-busy={submitting} className="composer" onSubmit={submit}>
      <textarea aria-label="输入任务" disabled={isRunning || isWaiting || submitting || Boolean(disabledReason)} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={disabledReason ?? (isWaiting ? "等待你的决定" : isRunning ? "Agent 正在处理" : submitting ? "正在创建任务" : "随心输入")} ref={textareaRef} value={draft} />
      <div className="composer-row">
        <div className="composer-left">
          <div className="add-selector">
            <IconButton className={`plain-icon ${mode === "plan" ? "is-active" : ""}`} label="添加" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}><Plus size={20} /></IconButton>
            {addMenuOpen && (
              <FloatingSurface className="add-menu" role="menu">
                <header>添加</header>
                <button
                  className={mode === "plan" ? "is-selected" : ""}
                  disabled={isRunning || isWaiting}
                  onClick={() => {
                    onModeChange(mode === "plan" ? "work" : "plan");
                    setAddMenuOpen(false);
                  }}
                  role="menuitemcheckbox"
                  aria-checked={mode === "plan"}
                  type="button"
                >
                  <Lightbulb size={16} />
                  <span>计划模式</span>
                  {mode === "plan" && <Check size={15} />}
                </button>
              </FloatingSurface>
            )}
          </div>
          <div className="permission-selector">
            <PillButton className="access-button" aria-expanded={accessMenuOpen} onClick={() => setAccessMenuOpen((open) => !open)}>
              <SelectedAccessIcon size={15} /><span>{selectedAccess.label}</span><ChevronDown size={13} />
            </PillButton>
            {accessMenuOpen && (
              <FloatingSurface className="permission-menu" role="menu">
                {accessOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      className={option.key === accessMode ? "is-selected" : ""}
                      key={option.key}
                      onClick={() => {
                        onAccessModeChange(option.key);
                        setAccessMenuOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon size={16} />
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      {option.key === accessMode && <Check size={15} />}
                    </button>
                  );
                })}
              </FloatingSurface>
            )}
          </div>
          {mode === "plan" && <PillButton className="mode-indicator" disabled={isRunning || isWaiting} onClick={() => onModeChange("work")} title="退出计划模式"><Lightbulb size={14} /><span>计划</span></PillButton>}
        </div>
        <div className="composer-right">
          <div className="context-meter" tabIndex={0} aria-label="上下文用量" onMouseEnter={onRefreshBalance} onFocus={onRefreshBalance}>
            <span
              className="context-meter-ring"
              style={{ "--context-progress": `${Math.max(2, contextSummary.utilization * 100)}%` } as CSSProperties}
            />
            <FloatingSurface className="context-inspector-popover" role="tooltip">
              <header>
                <strong>上下文容量</strong>
                <div className="context-header-actions">
                  <span>{formatTokens(contextSummary.used)}/{formatTokens(contextSummary.windowTokens)} ({(contextSummary.utilization * 100).toFixed(1)}%)</span>
                  <IconButton label="上下文分类排序" onClick={() => setContextSortMenuOpen((open) => !open)} title="排序"><ArrowUpDown size={12} /></IconButton>
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
              <footer><span>账户余额</span><strong>{formatBalance(balance)}</strong></footer>
              <footer><span>平均缓存命中率</span><strong>{contextSummary.cacheRate === undefined ? "尚无数据" : `${(contextSummary.cacheRate * 100).toFixed(1)}%`}</strong></footer>
            </FloatingSurface>
          </div>
          <div className="model-selector-wrapper">
            <PillButton aria-expanded={modelMenuOpen} className="model-button" disabled={isRunning} onClick={() => setModelMenuOpen((open) => !open)}><span>{models.find((item) => item.id === model)?.label ?? model}</span><ChevronDown size={13} /></PillButton>
            {modelMenuOpen && (
              <FloatingSurface className="model-menu">
                <header><span>选择模型</span></header>
                {models.map((option) => (
                  <button className={"model-option" + (option.id === model ? " is-selected" : "")} key={option.id} onClick={() => { onModelChange(option.id); setModelMenuOpen(false); }} type="button">
                    <span><span className="model-option-label">{option.label}</span><span className="model-option-desc">{option.description}</span></span>
                    {option.id === model && <Check size={14} className="model-option-check" />}
                  </button>
                ))}
              </FloatingSurface>
            )}
          </div>
          <IconButton className="plain-icon" disabled={isWaiting || submitting} label="语音输入"><Mic size={16} /></IconButton>{isRunning ? <IconButton className="send-button stop-button" label="停止" onClick={onCancel}><Square size={14} fill="currentColor" /></IconButton> : <IconButton className={"send-button" + (draft.trim() ? " has-draft" : "")} disabled={isWaiting || submitting || Boolean(disabledReason)} label="发送" type="submit"><ArrowUp size={18} /></IconButton>}
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

// 格式化账户余额。参考 cacheRate === undefined ? "尚无数据" 的现有风格:
// - balance 为 null(未配置 key 或查询失败)→ "尚无数据"
// - isAvailable: false(账户被禁用)→ "不可用"
// - 正常 → "¥9.23" / "$1.50"(按 currency 判断货币符号)
function formatBalance(value: RuntimeBalance | null | undefined): string {
  if (!value) return "尚无数据";
  if (!value.isAvailable) return "不可用";
  const info = value.balanceInfos[0];
  if (!info) return "尚无数据";
  const symbol = info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : "";
  return `${symbol}${info.totalBalance.toFixed(2)}`;
}
