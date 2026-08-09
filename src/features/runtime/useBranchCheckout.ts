import { useCallback } from "react";
import type { Session } from "../../../shared/contracts/runtime";
import type { RuntimeWorkspace } from "../../../shared/contracts/api";
import { runtimeApi } from "../../runtimeApi";

interface UseBranchCheckoutArgs {
  session: Session | null;
  setError: (error: string | null) => void;
  setWorkspace: (workspace: RuntimeWorkspace | null) => void;
}

// 切换本地分支:成功后用回读的 workspace 覆盖 state(Inspector/Composer 同步刷新);
// 失败(脏工作区冲突等)的原文走 setError → conversation-error-toast。运行中应由 UI 禁用,不在此判。
export function useBranchCheckout({ session, setError, setWorkspace }: UseBranchCheckoutArgs) {
  return useCallback(async (branch: string) => {
    if (!session) return;
    setError(null);
    try {
      const { workspace } = await runtimeApi.checkout(session.sessionId, branch);
      setWorkspace(workspace);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [session, setError, setWorkspace]);
}
