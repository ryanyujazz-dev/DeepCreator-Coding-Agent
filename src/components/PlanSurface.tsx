import { Check, ChevronDown, FilePenLine, Lightbulb, MessageSquareText, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AccessMode, Plan, PlanDecision, Question } from "../../shared/contracts/runtime";
import { MarkdownContent } from "./MarkdownContent";

const accessOptions: Array<{ key: AccessMode; label: string }> = [
  { key: "request_approval", label: "请求批准" },
  { key: "smart_approval", label: "智能审批" },
  { key: "full_access", label: "完全访问" }
];

export function PlanSurface({
  accessMode,
  onAnswerQuestion,
  onResolve,
  onRevise,
  plans,
  question
}: {
  accessMode: AccessMode;
  onAnswerQuestion: (interactionId: string, answers: Record<string, string>) => Promise<void> | void;
  onResolve: (plan: Plan, decision: PlanDecision, comments?: string, nextAccessMode?: AccessMode) => Promise<void> | void;
  onRevise: (plan: Plan, title: string, markdown: string) => Promise<void> | void;
  plans: Plan[];
  question?: Question;
}) {
  const orderedPlans = useMemo(() => [...plans].sort((left, right) => right.revision - left.revision), [plans]);
  const plan = orderedPlans[0];
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(plan?.title ?? "");
  const [markdown, setMarkdown] = useState(plan?.markdown ?? "");
  const [comments, setComments] = useState("");
  const [nextAccessMode, setNextAccessMode] = useState(accessMode);
  const [accessOpen, setAccessOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(plan?.title ?? "");
    setMarkdown(plan?.markdown ?? "");
    setEditing(false);
  }, [plan?.planId, plan?.revision]);
  useEffect(() => setNextAccessMode(accessMode), [accessMode]);

  const resolve = async (decision: PlanDecision) => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      await onResolve(plan, decision, comments, decision === "start_work" ? nextAccessMode : undefined);
      if (decision !== "continue_planning") setComments("");
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = async () => {
    if (!question || busy || question.prompts.some((prompt) => !answers[prompt.questionId]?.trim())) return;
    setBusy(true);
    try {
      await onAnswerQuestion(question.interactionId, answers);
      setAnswers({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-surface">
      <header className="plan-surface-header">
        <div>
          <Lightbulb size={15} />
          <span>实施方案</span>
          {plan && <small>第 {plan.revision} 版</small>}
        </div>
        {plan?.status === "proposed" && (
          <button aria-label={editing ? "关闭编辑" : "编辑方案"} onClick={() => setEditing((value) => !value)} type="button">
            {editing ? <X size={14} /> : <FilePenLine size={14} />}
          </button>
        )}
      </header>

      {question?.status === "pending" && (
        <section className="plan-question-panel">
          <header><MessageSquareText size={14} /><strong>需要你的决定</strong></header>
          {question.prompts.map((prompt) => (
            <fieldset key={prompt.questionId}>
              <legend>{prompt.prompt}</legend>
              {prompt.options?.length ? (
                <div className="plan-question-options">
                  {prompt.options.map((option) => (
                    <button
                      className={answers[prompt.questionId] === option ? "is-selected" : ""}
                      key={option}
                      onClick={() => setAnswers((current) => ({ ...current, [prompt.questionId]: option }))}
                      type="button"
                    >
                      <span>{option}</span>{answers[prompt.questionId] === option && <Check size={13} />}
                    </button>
                  ))}
                </div>
              ) : (
                <textarea
                  onChange={(event) => setAnswers((current) => ({ ...current, [prompt.questionId]: event.target.value }))}
                  placeholder={prompt.label}
                  value={answers[prompt.questionId] ?? ""}
                />
              )}
            </fieldset>
          ))}
          <button className="plan-primary-button" disabled={busy || question.prompts.some((prompt) => !answers[prompt.questionId]?.trim())} onClick={() => void submitAnswers()} type="button">提交回答</button>
        </section>
      )}

      {!plan && question?.status !== "pending" && <div className="surface-state">计划尚未生成。</div>}
      {plan && editing ? (
        <section className="plan-editor">
          <label>标题<input onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label>方案<textarea onChange={(event) => setMarkdown(event.target.value)} value={markdown} /></label>
          <div className="plan-editor-actions">
            <button onClick={() => setEditing(false)} type="button">取消</button>
            <button
              className="plan-primary-button"
              disabled={busy || !title.trim() || !markdown.trim() || (title === plan.title && markdown === plan.markdown)}
              onClick={async () => {
                setBusy(true);
                try {
                  await onRevise(plan, title, markdown);
                  setEditing(false);
                } finally {
                  setBusy(false);
                }
              }}
              type="button"
            >保存修订</button>
          </div>
        </section>
      ) : plan ? (
        <article className="plan-document">
          <div className="plan-title-row"><h1>{plan.title}</h1><span className={`plan-status is-${plan.status}`}>{statusLabel(plan.status)}</span></div>
          <MarkdownContent text={plan.markdown} />
        </article>
      ) : null}

      {plan?.status === "proposed" && !editing && question?.status !== "pending" && (
        <footer className="plan-review-bar">
          <textarea onChange={(event) => setComments(event.target.value)} placeholder="补充调整意见" value={comments} />
          <div className="plan-review-actions">
            <button disabled={busy} onClick={() => void resolve("cancel")} type="button">取消计划</button>
            <button disabled={busy} onClick={() => void resolve("continue_planning")} type="button">继续规划</button>
            <div className="plan-access-selector">
              <button aria-expanded={accessOpen} onClick={() => setAccessOpen((open) => !open)} type="button">
                <span>{accessOptions.find((option) => option.key === nextAccessMode)?.label}</span><ChevronDown size={13} />
              </button>
              {accessOpen && <div className="plan-access-menu">
                {accessOptions.map((option) => <button className={option.key === nextAccessMode ? "is-selected" : ""} key={option.key} onClick={() => { setNextAccessMode(option.key); setAccessOpen(false); }} type="button">{option.label}{option.key === nextAccessMode && <Check size={13} />}</button>)}
              </div>}
            </div>
            <button className="plan-primary-button" disabled={busy} onClick={() => void resolve("start_work")} type="button"><Play size={13} />开始执行</button>
          </div>
        </footer>
      )}
    </div>
  );
}

function statusLabel(status: Plan["status"]): string {
  if (status === "approved") return "已批准";
  if (status === "rejected") return "待调整";
  if (status === "superseded") return "旧版本";
  if (status === "draft") return "草稿";
  return "待审阅";
}
