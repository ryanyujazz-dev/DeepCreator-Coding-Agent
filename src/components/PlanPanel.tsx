import { CheckCircle2, Circle, LoaderCircle, OctagonX } from "lucide-react";
import { PlanStepView } from "../../shared/runtimeTypes";

export function PlanPanel({ steps }: { steps: PlanStepView[] }) {
  if (steps.length === 0) return <p className="inspector-empty">Agent 尚未建立计划</p>;
  return <div className="inspector-plan">{steps.map((step) => (
    <div className={`inspector-plan-row is-${step.state}`} key={step.stepKey}>
      {step.state === "completed" ? <CheckCircle2 size={13} /> : step.state === "in_progress" ? <LoaderCircle size={13} /> : step.state === "blocked" ? <OctagonX size={13} /> : <Circle size={13} />}
      <span>{step.label}</span>
    </div>
  ))}</div>;
}

