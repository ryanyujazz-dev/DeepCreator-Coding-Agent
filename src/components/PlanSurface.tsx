import { FilePenLine, Lightbulb, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Activity, Plan } from "../../shared/contracts/runtime";
import { useStreamText } from "../stream/useStreamText";
import { MarkdownContent } from "./MarkdownContent";

export function PlanSurface({
  activity,
  onRevise,
  plan,
  runActive
}: {
  activity?: Activity;
  onRevise: (plan: Plan, title: string, markdown: string) => Promise<void> | void;
  plan?: Plan;
  runActive: boolean;
}) {
  const sourceTitle = plan?.title ?? activity?.title ?? "正在编写计划";
  const sourceMarkdown = plan?.markdown ?? activity?.body ?? "";
  const streaming = runActive && activity?.status === "running" && !plan;
  const interrupted = !runActive && activity?.status === "running" && !plan;
  const streamed = useStreamText(sourceMarkdown, streaming);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(sourceTitle);
  const [markdown, setMarkdown] = useState(sourceMarkdown);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(sourceTitle);
    setMarkdown(sourceMarkdown);
    setEditing(false);
  }, [plan?.planId, plan?.revision, sourceMarkdown, sourceTitle]);

  return (
    <div className="plan-surface">
      <header className="plan-surface-header">
        <div>
          <Lightbulb size={15} />
          <span>实施方案</span>
          {plan && <small>第 {plan.revision} 版</small>}
          {streaming && <small className="working-glow">正在编写</small>}
          {interrupted && <small className="plan-stream-interrupted">生成中断</small>}
        </div>
        {plan?.status === "proposed" && (
          <button aria-label={editing ? "关闭编辑" : "编辑方案"} onClick={() => setEditing((value) => !value)} type="button">
            {editing ? <X size={14} /> : <FilePenLine size={14} />}
          </button>
        )}
      </header>

      {!activity && !plan && <div className="surface-state">计划内容不可用。</div>}
      {editing && plan ? (
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
      ) : activity || plan ? (
        <article className="plan-document">
          <div className="plan-title-row"><h1>{sourceTitle}</h1>{plan && <span className={`plan-status is-${plan.status}`}>{statusLabel(plan.status)}</span>}</div>
          <MarkdownContent fragments={streamed.fragments} stable={streamed.stable} streaming={streaming} />
        </article>
      ) : null}
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
