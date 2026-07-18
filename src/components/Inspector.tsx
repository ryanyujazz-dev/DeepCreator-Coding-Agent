import { Sparkles } from "lucide-react";
import { Changes, Session } from "../../shared/contracts/runtime";
import { PlanPanel } from "./PlanPanel";
import { EnvironmentPanel } from "./EnvironmentPanel";

export function Inspector({
  onOpenReview,
  session
}: {
  onOpenReview: (delta?: Changes) => void;
  session: Session | null;
}) {
  const run = session?.runs.at(-1);
  return (
    <aside className="environment-panel" aria-label="工作区信息">
      <EnvironmentPanel onOpenReview={onOpenReview} session={session} />
      <section className="environment-section plan-section">
        <header><span>执行计划</span></header>
        <div className="environment-row plan-row"><Sparkles size={15} /><span>{run?.plan.find((step) => step.status === "running")?.label ?? "当前没有执行中的步骤"}</span></div>
        <PlanPanel steps={run?.plan ?? []} />
      </section>
    </aside>
  );
}
