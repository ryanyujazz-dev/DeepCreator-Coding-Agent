import { CheckCircle2, Circle, LoaderCircle, OctagonX } from "lucide-react";
import { PlanItem } from "../../shared/contracts/runtime";

export function PlanPanel({ steps }: { steps: PlanItem[] }) {
  if (steps.length === 0) return <p className="inspector-empty">Agent 尚未建立计划</p>;
  return <div className="inspector-plan">{steps.map((step) => (
    <div className={`inspector-plan-row is-${step.status}`} key={step.stepId}>
      {step.status === "completed" ? <CheckCircle2 size={13} /> : step.status === "running" ? <LoaderCircle size={13} /> : step.status === "blocked" ? <OctagonX size={13} /> : <Circle size={13} />}
      <span>{step.label}</span>
    </div>
  ))}</div>;
}

