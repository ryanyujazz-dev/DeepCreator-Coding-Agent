import { useCallback, useEffect, useMemo, useState } from "react";
import { Changes, Session } from "../../../shared/contracts/runtime";
import type { Surface } from "../../components/SurfacePane";
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
  const activeFileState = activeSurface?.kind === "file" ? surfaceFiles[activeSurface.path] : undefined;

  const openFileSurface = useCallback((filePath: string) => {
    if (!session?.sessionId) return;
    const surfaceId = `file:${filePath}`;
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current
      : [...current, { id: surfaceId, kind: "file", path: filePath }]);
    setActiveSurfaceId(surfaceId);
    setSurfaceFiles((current) => ({
      ...current,
      [filePath]: { error: null, file: current[filePath]?.file ?? null, loading: true }
    }));
    void runtimeApi.getFile(session.sessionId, filePath)
      .then((file) => {
        setSurfaceFiles((current) => ({
          ...current,
          [filePath]: { error: null, file, loading: false }
        }));
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSurfaceFiles((current) => ({
          ...current,
          [filePath]: {
            error: /Route GET:\/api\/sessions\/.+\/files|not found/i.test(message)
              ? "文件读取接口未生效，请重启 Runtime。"
              : message,
            file: current[filePath]?.file ?? null,
            loading: false
          }
        }));
      });
  }, [session?.sessionId]);

  const openReviewSurface = useCallback((delta?: Changes) => {
    const reviewDelta = delta ?? [...(session?.runs ?? [])]
      .reverse()
      .map((run) => run.changes)
      .find((candidate) => candidate.comparisonBase === "run_start" && candidate.fileCount > 0);
    if (!reviewDelta || reviewDelta.comparisonBase !== "run_start" || reviewDelta.fileCount === 0) return;
    const surfaceId = `review:${reviewDelta.files.map((file) => file.path).join("|")}:${reviewDelta.additions}:${reviewDelta.deletions}`;
    const reviewSurface: Surface = { files: reviewDelta.files, id: surfaceId, kind: "review", title: "审阅" };
    setSurfaceClosing(false);
    setSurfaces((current) => current.some((candidate) => candidate.id === surfaceId)
      ? current.map((candidate) => candidate.id === surfaceId ? reviewSurface : candidate)
      : [...current, reviewSurface]);
    setActiveSurfaceId(surfaceId);
  }, [session?.runs]);

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
    openPlanSurface,
    openReviewSurface,
    setActiveSurfaceId,
    surfaceClosing,
    surfaces
  };
}
