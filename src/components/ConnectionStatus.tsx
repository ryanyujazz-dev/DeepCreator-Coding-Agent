import { CircleAlert, LoaderCircle, Wifi } from "lucide-react";

export type ConnectionPhase = "connecting" | "connected" | "reconnecting" | "offline";

export function ConnectionStatus({ phase }: { phase: ConnectionPhase }) {
  const label = {
    connected: "Runtime 已连接",
    connecting: "正在连接 Runtime",
    offline: "Runtime 离线",
    reconnecting: "正在恢复连接"
  }[phase];
  return (
    <div className={`connection-status is-${phase}`} title={label}>
      {phase === "connected" ? <Wifi size={12} /> : phase === "offline" ? <CircleAlert size={12} /> : <LoaderCircle size={12} />}
      <span className={phase === "connecting" || phase === "reconnecting" ? "working-glow" : ""}>{label}</span>
    </div>
  );
}
