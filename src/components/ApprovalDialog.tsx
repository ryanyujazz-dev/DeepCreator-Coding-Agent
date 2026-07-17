import { ShieldAlert } from "lucide-react";
import { ApprovalDecision, ApprovalView } from "../../shared/runtimeTypes";

export function ApprovalDialog({ approval, onResolve }: { approval?: ApprovalView; onResolve: (decision: ApprovalDecision) => void }) {
  if (!approval) return null;
  return (
    <section aria-live="polite" className="approval-dialog" role="group">
      <header><ShieldAlert size={16} /><div><strong>{approval.title}</strong><span>{approval.risk === "critical" ? "关键风险" : approval.risk === "high" ? "高风险" : "需要确认"}</span></div></header>
      <pre>{approval.detail}</pre>
      <footer>
        <button onClick={() => onResolve("deny")} type="button">拒绝</button>
        <button onClick={() => onResolve("allow_session")} type="button">本会话允许</button>
        <button onClick={() => onResolve("allow_cycle")} type="button">本轮允许</button>
        <button className="primary" onClick={() => onResolve("allow_once")} type="button">允许一次</button>
      </footer>
    </section>
  );
}
