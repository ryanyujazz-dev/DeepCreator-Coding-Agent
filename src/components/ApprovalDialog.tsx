import { ShieldAlert } from "lucide-react";
import { ApprovalChoice, Approval } from "../../shared/contracts/runtime";
import { PillButton } from "../shared-ui/ControlPrimitives";

export function ApprovalDialog({ approval, onResolve }: { approval?: Approval; onResolve: (decision: ApprovalChoice) => void }) {
  if (!approval) return null;
  return (
    <section aria-live="polite" className="approval-dialog" role="group">
      <header><ShieldAlert size={16} /><div><strong>{approval.title}</strong><span>{approval.risk === "critical" ? "关键风险" : approval.risk === "high" ? "高风险" : "需要确认"}</span></div></header>
      <pre>{approval.detail}</pre>
      <footer>
        {approval.choices.includes("deny") && <PillButton onClick={() => onResolve("deny")}>拒绝</PillButton>}
        {approval.choices.includes("allow_session") && <PillButton onClick={() => onResolve("allow_session")}>本会话允许</PillButton>}
        {approval.choices.includes("allow_run") && <PillButton onClick={() => onResolve("allow_run")}>本轮允许</PillButton>}
        {approval.choices.includes("allow_once") && <PillButton className="primary" onClick={() => onResolve("allow_once")}>允许一次</PillButton>}
      </footer>
    </section>
  );
}
