import { Sparkles } from "lucide-react";
import { WorkspaceSessionView } from "../../shared/runtimeTypes";
import { PlanPanel } from "./PlanPanel";
import { EnvironmentPanel } from "./EnvironmentPanel";

export function WorkspaceInspector({ session }: { session: WorkspaceSessionView | null }) {
  const cycle = session?.cycles.at(-1);
  return (
    <aside className="environment-panel" aria-label="工作区信息">
      <EnvironmentPanel session={session} />
      <section className="environment-section plan-section">
        <header><span>执行计划</span></header>
        <div className="environment-row plan-row"><Sparkles size={15} /><span>{cycle?.plan.find((step) => step.state === "in_progress")?.label ?? "当前没有执行中的步骤"}</span></div>
        <PlanPanel steps={cycle?.plan ?? []} />
      </section>
    </aside>
  );
}
