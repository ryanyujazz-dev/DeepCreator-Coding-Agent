import { useCallback, useEffect, useState } from "react";
import { Run, Session } from "../../../shared/contracts/runtime";
import {
  RuntimeBalance,
  RuntimeConfig,
  RuntimeContextObserver,
  RuntimeWorkspace,
  runtimeApi
} from "../../runtimeApi";

type RuntimeObserverInput = {
  activeRun?: Run;
  config: RuntimeConfig | null;
  session: Session | null;
};

export function useRuntimeObservers({ activeRun, config, session }: RuntimeObserverInput) {
  const [contextObserver, setContextObserver] = useState<RuntimeContextObserver | null>(null);
  const [workspace, setWorkspace] = useState<RuntimeWorkspace | null>(null);
  const [balance, setBalance] = useState<RuntimeBalance | null>(null);
  // 用 runId 字符串(流式期间对同一 run 恒定)而非 activeRun 对象作依赖:reducer 每事件
  // structuredClone 整个 session,activeRun 对象每事件都是新引用;若把它(或 session?.updatedAt)
  // 放进下面两个轮询 effect 的 deps,每个 SSE 事件都会拆重建 effect —— 立刻多打一次
  // getWorkspace/getContextObserver 往返,且 setInterval 被清重建、永远走不到稳定的 2s/3s 节律。
  // runId 仅在 run 起停时变化 → effect 只在那时重跑,流式期间按固定间隔稳定轮询。
  const activeRunId = activeRun?.runId ?? null;

  useEffect(() => {
    if (!session?.sessionId) {
      setWorkspace(null);
      return;
    }
    let disposed = false;
    const sessionId = session.sessionId;
    const refresh = () => void runtimeApi.getWorkspace(sessionId)
      .then(({ workspace: next }) => { if (!disposed) setWorkspace(next); })
      .catch(() => { if (!disposed) setWorkspace(null); });
    refresh();
    const timer = activeRunId ? window.setInterval(refresh, 3_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRunId, session?.sessionId]);

  useEffect(() => {
    const sessionId = session?.sessionId;
    if (!sessionId) {
      setContextObserver(null);
      return;
    }
    let disposed = false;
    const refresh = () => void runtimeApi.getContextObserver(sessionId)
      .then(({ observer }) => { if (!disposed) setContextObserver(observer); })
      .catch(() => undefined);
    refresh();
    const timer = activeRunId ? window.setInterval(refresh, 2_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRunId, session?.sessionId]);

  // 余额是账户级辅助信息：首次配置后获取一次，之后由 UI 悬浮按需刷新。
  const refreshBalance = useCallback(() => {
    if (!config?.hasApiKey) {
      setBalance(null);
      return;
    }
    void runtimeApi.getBalance()
      .then((result) => setBalance(result))
      .catch(() => undefined);
  }, [config?.hasApiKey]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  return { balance, contextObserver, refreshBalance, setWorkspace, workspace };
}
