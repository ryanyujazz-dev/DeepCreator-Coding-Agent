import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Mic,
  ShieldAlert,
  X
} from "lucide-react";
import React from "react";
import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessMode,
  Approval,
  ApprovalChoice,
  Plan,
  PlanDecision,
  Question,
  QuestionAnswer
} from "../../shared/contracts/runtime";
import { normalizeQuestionPrompt, NormalizedQuestionPrompt } from "../../shared/domain/questions";
import { IconButton } from "../shared-ui/ControlPrimitives";

type Props = {
  accessMode: AccessMode;
  approval?: Approval;
  plan?: Plan;
  question?: Question;
  onAnswerQuestion: (interactionId: string, answers: Record<string, QuestionAnswer>) => Promise<void> | void;
  onInterruptQuestion: (interactionId: string, prompt: string) => Promise<boolean>;
  onResolveApproval: (decision: ApprovalChoice) => Promise<void> | void;
  onResolvePlan: (plan: Plan, decision: PlanDecision, nextAccessMode?: AccessMode) => Promise<void> | void;
};

const approvalLabels: Record<ApprovalChoice, string> = {
  allow_once: "允许一次",
  allow_run: "本轮允许",
  allow_session: "始终允许",
  deny: "拒绝"
};

type InteractionComposerShellProps = {
  actions: ReactNode;
  actionsClassName?: string;
  busy: boolean;
  children: ReactNode;
  className: string;
  collapsed?: boolean;
  label: string;
  onKeyDown?: (event: KeyboardEvent<HTMLFormElement>) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

function InteractionComposerShell({
  actions,
  actionsClassName,
  busy,
  children,
  className,
  collapsed = false,
  label,
  onKeyDown,
  onSubmit
}: InteractionComposerShellProps) {
  const expandableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const expandable = expandableRef.current;
    if (!expandable) return;
    if (collapsed) expandable.setAttribute("inert", "");
    else expandable.removeAttribute("inert");
  }, [collapsed]);

  return (
    <form
      aria-busy={busy}
      aria-label={label}
      aria-live="polite"
      className={`composer agent-interaction-shell ${collapsed ? "is-collapsed" : "is-expanded"} ${className}`}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        if (onSubmit) onSubmit(event);
        else event.preventDefault();
      }}
      role="group"
    >
      <div aria-hidden={collapsed || undefined} className="agent-interaction-expandable" ref={expandableRef}>
        <div className="agent-interaction-panel">{children}</div>
      </div>
      <footer className={`agent-interaction-bar ${collapsed ? "agent-question-collapsed-bar" : `agent-interaction-actions${actionsClassName ? ` ${actionsClassName}` : ""}`}`}>
        {actions}
      </footer>
    </form>
  );
}

export function AgentInteractionComposer(props: Props) {
  if (props.approval) return <ApprovalInteraction {...props} approval={props.approval} />;
  if (props.plan) return <PlanInteraction {...props} plan={props.plan} />;
  if (props.question) return <QuestionInteraction {...props} question={props.question} />;
  return null;
}

function ApprovalInteraction({ approval, onResolveApproval }: Props & { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: ApprovalChoice) => {
    if (busy) return;
    setBusy(true);
    try {
      await onResolveApproval(decision);
    } finally {
      setBusy(false);
    }
  };
  const closeDecision = approval.choices.includes("deny") ? "deny" : approval.choices[0];
  return (
    <InteractionComposerShell
      actions={approval.choices.map((choice) => (
        <button className={choice === "allow_once" ? "is-primary" : choice === "deny" ? "is-negative" : ""} disabled={busy} key={choice} onClick={() => void resolve(choice)} type="button">
          {approvalLabels[choice]}
        </button>
      ))}
      busy={busy}
      className="approval-interaction"
      label="批准请求"
    >
      <header className="agent-interaction-header">
        <span className="agent-interaction-heading-icon"><ShieldAlert aria-hidden="true" size={15} /></span>
        <div><strong>{approval.title}</strong><small>{approval.risk === "critical" ? "关键风险" : approval.risk === "high" ? "高风险" : "需要确认"}</small></div>
        {closeDecision ? <IconButton className="agent-corner-action is-top-right" disabled={busy} label="拒绝并关闭" onClick={() => void resolve(closeDecision)}><X size={15} /></IconButton> : null}
      </header>
      <div className="agent-interaction-body"><pre className="agent-interaction-detail">{approval.detail}</pre></div>
    </InteractionComposerShell>
  );
}

function PlanInteraction({ accessMode, onResolvePlan, plan }: Props & { plan: Plan }) {
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: PlanDecision) => {
    if (busy) return;
    setBusy(true);
    try {
      await onResolvePlan(plan, decision, decision === "start_work" ? accessMode : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InteractionComposerShell
      actions={<button className="is-negative" disabled={busy} onClick={() => void resolve("cancel")} type="button">取消计划</button>}
      busy={busy}
      className="plan-interaction"
      label="计划确认"
    >
      <header className="agent-interaction-header">
        <div><strong>实施此计划？</strong><small>{plan.title}</small></div>
        <IconButton className="agent-corner-action is-top-right" disabled={busy} label="取消计划" onClick={() => void resolve("cancel")}><X size={15} /></IconButton>
      </header>
      <div className="agent-interaction-body plan-interaction-options">
        <button className="agent-plan-choice is-primary" disabled={busy} onClick={() => void resolve("start_work")} type="button"><span>开始实施</span><small>按当前权限设置执行已审阅方案</small></button>
        <button className="agent-plan-choice" disabled={busy} onClick={() => void resolve("continue_planning")} type="button"><span>继续规划</span><small>让 Agent 继续完善当前方案</small></button>
      </div>
    </InteractionComposerShell>
  );
}

function QuestionInteraction({ onAnswerQuestion, onInterruptQuestion, question }: Props & { question: Question }) {
  const prompts = useMemo(() => question.prompts.map(normalizeQuestionPrompt), [question.prompts]);
  const isPlanEntry = question.purpose === "plan_entry"
    || (prompts.length === 1 && prompts[0]?.questionId === "plan_entry");
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const prompt = prompts[questionIndex] ?? prompts[0];

  useEffect(() => {
    setAnswers({});
    setBusy(false);
    setCollapsed(false);
    setDraft("");
    setQuestionIndex(0);
  }, [question.interactionId]);

  const submitAnswers = async (nextAnswers: Record<string, QuestionAnswer>) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAnswerQuestion(question.interactionId, nextAnswers);
    } finally {
      setBusy(false);
    }
  };
  const skipAll = () => void submitAnswers(Object.fromEntries(prompts.map((item) => [item.questionId, { status: "skipped" } satisfies QuestionAnswer])));
  const moveForward = (answer: QuestionAnswer) => {
    const nextAnswers = { ...answers, [prompt.questionId]: answer };
    setAnswers(nextAnswers);
    if (questionIndex < prompts.length - 1) setQuestionIndex((value) => value + 1);
    else void submitAnswers(nextAnswers);
  };
  const submitCurrent = () => {
    const answer = answers[prompt.questionId];
    if (answer && answerIsValid(prompt, answer)) moveForward(answer);
  };
  const chooseOption = (optionId: string) => {
    const current = answers[prompt.questionId];
    const currentChoice = current?.status === "answered" && current.answer.kind === "choice" ? current.answer : undefined;
    if (prompt.type === "single_choice") {
      setAnswers((value) => ({ ...value, [prompt.questionId]: { status: "answered", answer: { kind: "choice", optionIds: [optionId] } } }));
      return;
    }
    const selected = new Set(currentChoice?.optionIds ?? []);
    if (selected.has(optionId)) selected.delete(optionId);
    else selected.add(optionId);
    setAnswers((value) => ({
      ...value,
      [prompt.questionId]: {
        status: "answered",
        answer: { kind: "choice", optionIds: [...selected], ...(currentChoice?.customText ? { customText: currentChoice.customText } : {}) }
      }
    }));
  };
  const setCustomText = (text: string) => {
    const current = answers[prompt.questionId];
    const currentChoice = current?.status === "answered" && current.answer.kind === "choice" ? current.answer : undefined;
    setAnswers((value) => ({
      ...value,
      [prompt.questionId]: {
        status: "answered",
        answer: {
          kind: "choice",
          optionIds: prompt.type === "single_choice" ? [] : currentChoice?.optionIds ?? [],
          customText: text
        }
      }
    }));
  };
  const setTextAnswer = (text: string) => setAnswers((value) => ({
    ...value,
    [prompt.questionId]: { status: "answered", answer: { kind: "text", text } }
  }));
  const handleKeys = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
    const optionIndex = Number(event.key) - 1;
    if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < prompt.options.length) {
      event.preventDefault();
      chooseOption(prompt.options[optionIndex].optionId);
    } else if (event.key === "Enter") {
      event.preventDefault();
      submitCurrent();
    }
  };
  const interrupt = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      if (await onInterruptQuestion(question.interactionId, text)) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const currentAnswer = answers[prompt.questionId];
  const currentChoice = currentAnswer?.status === "answered" && currentAnswer.answer.kind === "choice" ? currentAnswer.answer : undefined;
  const customText = currentChoice?.customText ?? "";
  const isGroup = prompts.length > 1;
  return (
    <InteractionComposerShell
      actions={collapsed ? (
        <>
          <IconButton className="agent-corner-action is-bottom-left" label="展开问题" onClick={() => setCollapsed(false)}><ChevronUp size={16} /></IconButton>
          <textarea aria-label="结束澄清并输入新任务" disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder="输入新内容以结束问题澄清" rows={1} value={draft} />
          <div className="agent-question-collapsed-actions">
            <IconButton className="plain-icon" disabled={busy} label="语音输入"><Mic size={16} /></IconButton>
            <IconButton className={`send-button${draft.trim() ? " has-draft" : ""}`} disabled={busy || !draft.trim()} label="发送并开始新任务" type="submit"><ArrowUp size={18} /></IconButton>
          </div>
        </>
      ) : (
        <>
          {questionIndex > 0 ? <IconButton className="agent-corner-action is-bottom-left" disabled={busy} label="返回上一个问题" onClick={() => setQuestionIndex((value) => value - 1)}><ChevronLeft size={15} /></IconButton> : <span />}
          <div><button disabled={busy} onClick={() => moveForward({ status: "skipped" })} type="button">跳过</button><button className="is-primary" disabled={busy || !currentAnswer || !answerIsValid(prompt, currentAnswer)} onClick={submitCurrent} type="button">{questionIndex < prompts.length - 1 ? "下一步" : "提交"}</button></div>
        </>
      )}
      actionsClassName="question-actions"
      busy={busy}
      className={`question-interaction${isPlanEntry ? " plan-entry-interaction" : ""}`}
      collapsed={collapsed}
      label={isPlanEntry ? "计划模式确认" : "问题澄清"}
      onKeyDown={collapsed ? undefined : handleKeys}
      onSubmit={collapsed ? interrupt : undefined}
    >
      <header className="agent-interaction-header question-interaction-header">
        <div className="question-title-row">
          {isGroup ? <span className="question-progress">{questionIndex + 1}/{prompts.length}</span> : null}
          <strong>{isPlanEntry ? "是否进入计划模式？" : prompt.prompt}</strong>
          {prompt.type === "multiple_choice" ? <small className="question-kind">可多选</small> : null}
        </div>
        <div className="agent-top-actions">
          {!isPlanEntry ? <IconButton className="agent-corner-action is-collapse" disabled={busy} label="收起问题" onClick={() => setCollapsed(true)}><ChevronDown size={15} /></IconButton> : null}
          <IconButton className="agent-corner-action is-top-right" disabled={busy} label="跳过全部问题" onClick={skipAll}><X size={15} /></IconButton>
        </div>
      </header>
      <div className="agent-interaction-body question-options">
        {prompt.type !== "text" ? prompt.options.map((option, index) => {
          const selected = currentChoice?.optionIds.includes(option.optionId) ?? false;
          return (
            <button aria-pressed={selected} className={`question-option${selected ? " is-selected" : ""}`} disabled={busy} key={option.optionId} onClick={() => chooseOption(option.optionId)} type="button">
              <span className="question-option-copy"><span><strong>{option.title}</strong>{option.recommended ? <em>（推荐）</em> : null}</span>{option.description ? <small>{option.description}</small> : null}</span>
              <span className="question-option-number">{index + 1}</span>
              {selected ? <Check aria-hidden="true" size={15} /> : null}
            </button>
          );
        }) : null}
        {prompt.type !== "text" && !isPlanEntry ? (
          <label className={`question-other${customText.trim() ? " is-selected" : ""}`}>
            <span>其他</span>
            <input disabled={busy} onChange={(event) => setCustomText(event.target.value)} placeholder="输入自己的答案" value={customText} />
            <span className="question-option-number">{prompt.options.length + 1}</span>
          </label>
        ) : prompt.multiline ? (
          <textarea className="question-text-answer" disabled={busy} onChange={(event) => setTextAnswer(event.target.value)} placeholder={prompt.placeholder ?? "输入回答"} value={currentAnswer?.status === "answered" && currentAnswer.answer.kind === "text" ? currentAnswer.answer.text : ""} />
        ) : (
          <input className="question-text-answer" disabled={busy} onChange={(event) => setTextAnswer(event.target.value)} placeholder={prompt.placeholder ?? "输入回答"} value={currentAnswer?.status === "answered" && currentAnswer.answer.kind === "text" ? currentAnswer.answer.text : ""} />
        )}
      </div>
    </InteractionComposerShell>
  );
}

function answerIsValid(prompt: NormalizedQuestionPrompt, answer: QuestionAnswer): boolean {
  if (answer.status === "skipped") return true;
  if (prompt.type === "text") return answer.answer.kind === "text" && Boolean(answer.answer.text.trim());
  if (answer.answer.kind !== "choice") return false;
  const count = new Set(answer.answer.optionIds).size + (answer.answer.customText?.trim() ? 1 : 0);
  if (prompt.type === "single_choice") return count === 1;
  return count >= (prompt.minSelections ?? 1) && count <= (prompt.maxSelections ?? prompt.options.length + 1);
}
