import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Changes, Session, isRunDone } from "../../../shared/contracts/runtime";
import { clearProjectChanges } from "../../components/SurfacePane";
import type { ReviewSurfacePatch, Surface } from "../../components/SurfacePane";
import { RuntimeFilePreview, runtimeApi } from "../../runtimeApi";

type SurfaceFileState = {
  error: string | null;
  file: RuntimeFilePreview | null;
  loading: boolean;
};

export function useSurfaceWorkspace(session: Session | null) {
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [surfaceFiles, setSurfaceFiles] = useState<Record<string, SurfaceFileState>>({});
  const [surfaceClosing, setSurfaceClosing] = useState(false);

  const activeSurface = useMemo(
    () => surfaces.find((candidate) => candidate.id === activeSurfaceId) ?? surfaces[0] ?? null,
    [activeSurfaceId, surfaces]
  );
  const activeFileState = activeSurface?.kind === "file" ? surfaceFiles[activeSurface.id] : undefined;

  const openFileSurface = useCallback((filePath: string, ownerSessionId = session?.sessionId) => {
    if (!ownerSessionId) return;
    const surfaceId = `file:${ownerSessionId}:${filePath}`;
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current
      : [...current, { id: surfaceId, kind: "file", ownerSessionId, path: filePath }]);
    setActiveSurfaceId(surfaceId);
    setSurfaceFiles((current) => ({
      ...current,
      [surfaceId]: { error: null, file: current[surfaceId]?.file ?? null, loading: true }
    }));
    void runtimeApi.getFile(ownerSessionId, filePath)
      .then((file) => {
        setSurfaceFiles((current) => ({
          ...current,
          [surfaceId]: { error: null, file, loading: false }
        }));
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSurfaceFiles((current) => ({
          ...current,
          [surfaceId]: {
            error: /Route GET:\/api\/sessions\/.+\/files|not found/i.test(message)
              ? "文件读取接口未生效，请重启 Runtime。"
              : message,
            file: current[surfaceId]?.file ?? null,
            loading: false
          }
        }));
      });
  }, [session?.sessionId]);

  const openAgentSurface = useCallback((childSessionId: string, delegationId: string, title?: string) => {
    const surface: Surface = {
      delegationId,
      id: `agent:${childSessionId}`,
      kind: "agent",
      sessionId: childSessionId,
      title: title ?? "子代理"
    };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surface.id)
      ? current.map((candidate) => candidate.id === surface.id ? surface : candidate)
      : [...current, surface]);
    setActiveSurfaceId(surface.id);
  }, []);

  const openReviewSurface = useCallback((delta?: Changes, ownerSessionId = session?.sessionId) => {
    const reviewDelta = delta ?? [...(session?.runs ?? [])]
      .reverse()
      .map((run) => run.changes)
      .find((candidate) => candidate.comparisonBase === "run_start" && candidate.fileCount > 0);
    if (!reviewDelta || reviewDelta.comparisonBase !== "run_start" || reviewDelta.fileCount === 0) return;
    const surfaceId = `review:${ownerSessionId ?? "unknown"}:${reviewDelta.files.map((file) => file.path).join("|")}:${reviewDelta.additions}:${reviewDelta.deletions}`;
    const reviewSurface: Surface = { files: reviewDelta.files, id: surfaceId, kind: "review", ownerSessionId, projectRoot: session?.projectRoot, title: "审阅" };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current.map((candidate) => candidate.id === surfaceId ? reviewSurface : candidate)
      : [...current, reviewSurface]);
    setActiveSurfaceId(surfaceId);
  }, [session?.runs, session?.sessionId, session?.projectRoot]);

  const openPlanSurface = useCallback((runId: string, callId: string) => {
    const plan = [...(session?.plans ?? [])].reverse().find((candidate) => candidate.runId === runId && candidate.callId === callId);
    const surface: Surface = {
      callId,
      id: `plan:${runId}:${callId}`,
      kind: "plan",
      runId,
      title: plan?.title ?? "计划"
    };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surface.id)
      ? current.map((candidate) => candidate.id === surface.id ? { ...candidate, title: surface.title } : candidate)
      : [...current, surface]);
    setActiveSurfaceId(surface.id);
  }, [session?.plans]);

  useEffect(() => {
    const plans = session?.plans ?? [];
    setSurfaces((current) => {
      let changed = false;
      const next = current.map((surface) => {
        if (surface.kind !== "plan") return surface;
        const plan = [...plans].reverse().find((candidate) => candidate.runId === surface.runId && candidate.callId === surface.callId);
        if (!plan || plan.title === surface.title) return surface;
        changed = true;
        return { ...surface, title: plan.title };
      });
      return changed ? next : current;
    });
  }, [session?.plans]);

  // "所有变更" 按项目共享(见 SurfacePane.projectChangesCache)。当某个 run 在当前活动会话里
  // 完成,意味着工作树已落地新改动:清掉该项目的缓存,下次查看会重新拉取,避免跨会话复用过期快照。
  // 切换会话本身只快照、不清空,所以"A 看过 → 切 B 查看"仍能复用;只有"新跑完一轮"才刷新。
  const completedRunsTrackerRef = useRef<{ runIds: Set<string>; sessionId: string | null }>({ runIds: new Set(), sessionId: null });
  useEffect(() => {
    const sessionId = session?.sessionId ?? null;
    const projectRoot = session?.projectRoot;
    const completedIds = (session?.runs ?? []).filter((run) => isRunDone(run.status)).map((run) => run.runId);
    const tracker = completedRunsTrackerRef.current;
    if (tracker.sessionId !== sessionId) {
      tracker.sessionId = sessionId;
      tracker.runIds = new Set(completedIds);
      return;
    }
    const fresh = completedIds.filter((runId) => !tracker.runIds.has(runId));
    if (fresh.length === 0) return;
    fresh.forEach((runId) => tracker.runIds.add(runId));
    if (projectRoot) clearProjectChanges(projectRoot);
  }, [session?.sessionId, session?.runs, session?.projectRoot]);

  // Per-session cache: switching conversations preserves each session's open
  // tabs for the lifetime of the app. It lives only in memory, so it clears on
  // exit without any explicit teardown.
  const surfaceCacheRef = useRef(new Map<string, { activeSurfaceId: string | null; surfaceFiles: Record<string, SurfaceFileState>; surfaces: Surface[] }>());
  const previousSessionIdRef = useRef<string | null>(session?.sessionId ?? null);
  useEffect(() => {
    const nextSessionId = session?.sessionId ?? null;
    if (previousSessionIdRef.current === nextSessionId) return;
    if (previousSessionIdRef.current) {
      surfaceCacheRef.current.set(previousSessionIdRef.current, { activeSurfaceId, surfaceFiles, surfaces });
    }
    const cached = nextSessionId ? surfaceCacheRef.current.get(nextSessionId) : undefined;
    if (cached) {
      setSurfaces(cached.surfaces);
      setActiveSurfaceId(cached.activeSurfaceId);
      setSurfaceFiles(cached.surfaceFiles);
    } else {
      setSurfaces([]);
      setActiveSurfaceId(null);
      setSurfaceFiles({});
    }
    setSurfaceClosing(false);
    previousSessionIdRef.current = nextSessionId;
  }, [session?.sessionId, surfaces, activeSurfaceId, surfaceFiles]);

  const updateReviewSurface = useCallback((surfaceId: string, patch: ReviewSurfacePatch) => {
    setSurfaces((current) => current.map((candidate) => (
      candidate.id === surfaceId && candidate.kind === "review"
        ? { ...candidate, ...patch }
        : candidate
    )));
  }, []);

  const closeSurfaceTab = useCallback((surfaceId: string) => {
    setSurfaces((current) => {
      const closingIndex = current.findIndex((candidate) => candidate.id === surfaceId);
      if (closingIndex === -1) return current;
      const next = current.filter((candidate) => candidate.id !== surfaceId);
      if (next.length === 0) {
        setSurfaceClosing(true);
        window.setTimeout(() => {
          setActiveSurfaceId(null);
          setSurfaceClosing(false);
        }, 190);
        return next;
      }
      if (activeSurfaceId === surfaceId) {
        setActiveSurfaceId(next[Math.min(closingIndex, next.length - 1)]?.id ?? next[0].id);
      }
      return next;
    });
  }, [activeSurfaceId]);

  const closeActiveSurface = useCallback(() => {
    if (activeSurfaceId) closeSurfaceTab(activeSurfaceId);
  }, [activeSurfaceId, closeSurfaceTab]);

  return {
    activeFileState,
    activeSurface,
    closeActiveSurface,
    closeSurfaceTab,
    openFileSurface,
    openAgentSurface,
    openPlanSurface,
    openReviewSurface,
    setActiveSurfaceId,
    surfaceClosing,
    surfaces,
    updateReviewSurface
  };
}
