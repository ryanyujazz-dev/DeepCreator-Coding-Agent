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
    const timer = activeRun ? window.setInterval(refresh, 3_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRun, session?.sessionId, session?.updatedAt]);

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
    const timer = activeRun ? window.setInterval(refresh, 2_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRun, session?.sessionId, session?.updatedAt]);

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
