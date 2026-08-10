import React, { useEffect, useSyncExternalStore } from "react";
import { AccessMode, isRunDone } from "../../shared/contracts/runtime";
import { SessionEventStore } from "../features/runtime/sessionEventStore";
import { runtimeApi, RuntimeConfig } from "../runtimeApi";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import type { Surface } from "./SurfacePane";
import { browserPlatform } from "../platform/browser";

const ACCESS_ORDER: AccessMode[] = ["request_approval", "smart_approval", "full_access"];

export function AgentSurface({
  onOpenFile,
  onOpenReview,
  surface
}: {
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: import("../../shared/contracts/runtime").Changes) => void;
  surface: Extract<Surface, { kind: "agent" }>;
}) {
  const [store] = React.useState(() => new SessionEventStore());
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [config, setConfig] = React.useState<RuntimeConfig | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    setLoadError(null);
    void Promise.all([runtimeApi.getSession(surface.sessionId), runtimeApi.config()])
      .then(([result, nextConfig]) => {
        if (disposed) return;
        store.replaceSnapshot(result.session);
        setConfig(nextConfig);
        unsubscribe = runtimeApi.subscribe({
          afterOffset: result.session.lastOffset,
          onError: (error) => {
            if (!disposed && !store.getSnapshot()) setLoadError(error instanceof Error ? error.message : String(error));
          },
          onEvents: (events) => store.applyEvents(surface.sessionId, events),
          onOpen: () => undefined,
          sessionId: surface.sessionId
        });
      })
      .catch((error) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [store, surface.sessionId]);

  const activeRun = [...(session?.runs ?? [])].reverse().find((run) => !isRunDone(run.status));
  const pendingQuestion = session?.questions.find((question) => question.status === "pending");
  const pendingPlan = activeRun
    ? [...(session?.plans ?? [])].reverse().find((plan) => plan.runId === activeRun.runId && plan.status === "proposed")
    : undefined;
  const pendingApproval = activeRun?.approvals.find((approval) => approval.state === "pending");
  const replace = (next: Awaited<ReturnType<typeof runtimeApi.getSession>>) => store.replaceSnapshot(next.session);
  const submit = async (prompt: string) => {
    if (!session) return false;
    const next = activeRun
      ? await runtimeApi.queueFollowUp(session.sessionId, {
          accessMode: session.accessMode,
          mode: "work",
          model: session.model,
          planEntry: "manual",
          prompt
        })
      : await runtimeApi.startRun({
          accessMode: session.accessMode,
          mode: "work",
          model: session.model,
          planEntry: "manual",
          prompt,
          sessionId: session.sessionId
        });
    replace(next);
    return true;
  };
  const setAccessMode = async (accessMode: AccessMode) => {
    if (!session || ACCESS_ORDER.indexOf(accessMode) > ACCESS_ORDER.indexOf(session.accessMode)) return;
    replace(await runtimeApi.setAccessMode(session.sessionId, accessMode));
  };

  if (!session) return <div className={`surface-state ${loadError ? "is-error" : "is-loading working-glow"}`}>{loadError ?? "正在连接子代理..."}</div>;
  return (
    <div className="agent-surface conversation-main">
      <Conversation
        onOpenAgent={() => undefined}
        onOpenFile={onOpenFile}
        onOpenPlan={() => undefined}
        onOpenReview={onOpenReview}
        onStopCommand={(commandId) => void runtimeApi.stopCommand(commandId)}
        session={session}
      />
      <div className="composer-stack agent-composer-stack">
        <Composer
          accessMode={session.accessMode}
          contextConfig={config}
          contextObserver={null}
          followUps={session.followUps}
          isRunning={Boolean(activeRun && activeRun.status === "running")}
          isWaiting={Boolean(activeRun && activeRun.status === "waiting")}
          mode={session.mode}
          model={session.model}
          models={config?.models ?? []}
          onAccessModeChange={(mode) => void setAccessMode(mode)}
          onAnswerQuestion={async (interactionId, answers) => {
            await runtimeApi.answerQuestion(session.sessionId, interactionId, answers);
            replace(await runtimeApi.getSession(session.sessionId));
          }}
          onInterruptQuestion={async (interactionId, prompt) => {
            const response = await runtimeApi.interruptQuestion(session.sessionId, interactionId, {
              accessMode: session.accessMode,
              mode: session.mode,
              model: session.model,
              planEntry: session.planEntry,
              prompt,
              requestId: browserPlatform.createId("question_interrupt")
            });
            store.replaceSnapshot(response.session);
            return true;
          }}
          onCancel={() => activeRun && void runtimeApi.cancelRun(activeRun.runId)}
          onModeChange={() => undefined}
          onModelChange={() => undefined}
          onRefreshBalance={() => undefined}
          onRemoveFollowUp={async (followUpId) => replace(await runtimeApi.removeFollowUp(session.sessionId, followUpId))}
          onResolveApproval={(decision) => runtimeApi.resolveApproval(pendingApproval!.approvalId, decision).then(() => undefined)}
          onResolvePlan={async (plan, decision, _comments, nextAccessMode) => {
            const response = await runtimeApi.resolvePlan(session.sessionId, plan, { accessMode: nextAccessMode, decision });
            store.replaceSnapshot(response.session);
          }}
          onSteerFollowUp={async (followUpId) => replace(await runtimeApi.steerFollowUp(session.sessionId, followUpId))}
          onSubmit={submit}
          pendingApproval={pendingApproval}
          pendingPlan={pendingPlan}
          pendingQuestion={pendingQuestion}
          resetKey={session.sessionId}
        />
      </div>
    </div>
  );
}
