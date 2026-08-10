import { ChevronDown, ChevronRight } from "lucide-react";
import React, { memo, useEffect, useMemo, useState } from "react";
import { Run, Changes, Plan, Question, isRunDone } from "../../shared/contracts/runtime";
import { projectDisplayTimeline } from "../../shared/projections/displaySegments";
import { projectResponsesDisplayTimeline, responsesDisplayActivities } from "../../shared/projections/responsesDisplayTimeline";
import { DisplayTimelineEntry } from "../../shared/projections/types";
import { ActivityView } from "./ActivityView";
import { ChangePanel } from "./ChangePanel";
import { DisplaySegmentRenderer } from "./DisplaySegmentRenderer";
import { MarkdownContent } from "./MarkdownContent";
import { ResponsesDisplaySegmentRenderer } from "./ResponsesDisplaySegmentRenderer";

type UserMessageEntry = Extract<DisplayTimelineEntry, { type: "activity" }>;

export type RunConversationTurn = {
  entries: DisplayTimelineEntry[];
  turnId: string;
  userMessage?: UserMessageEntry;
};

export function splitTimelineIntoConversationTurns(runId: string, entries: DisplayTimelineEntry[]): RunConversationTurn[] {
  const turns: RunConversationTurn[] = [{ entries: [], turnId: `turn:${runId}:prompt` }];
  for (const entry of entries) {
    if (entry.type === "activity" && entry.activity.kind === "user_message") {
      turns.push({ entries: [], turnId: `turn:${entry.entryId}`, userMessage: entry });
      continue;
    }
    turns[turns.length - 1].entries.push(entry);
  }
  return turns;
}

// Run 计时器:独立 1s tick,不依赖 SSE 驱动的重渲。
// 旧实现 elapsed(run) 在渲染期调 Date.now(),而 RunTimeline 只在 SSE 事件(session 变化)时重渲 →
// 等首 token / 工具执行时无事件 → elapsed 冻结;事件密集时每帧 run 引用变 → 狂跳。抽成子组件,
// 内部按 active 门控每秒 setNow → 只重渲自己(不触发 RunTimeline 重渲,保护 memo + projection useMemo)。
// active 时每秒走秒稳定;!active 时定格(finishedAt - startedAt)、不 tick(省一个定时器)。
// run.started 早于 reasoning(startRun.ts append 先于 launch),故 run 一挂载计时器就走 —— 修复
// 「模型思考时计时器才动」(原 elapsed 冻结在 0s 直到 reasoning 文本驱动重渲)。照搬 DisplaySegmentRenderer
// 的 1s tick 范本。
function RunElapsed({ startedAt, finishedAt, active }: { startedAt: string; finishedAt?: string; active: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const seconds = Math.max(0, Math.floor(((finishedAt ? new Date(finishedAt).getTime() : now) - new Date(startedAt).getTime()) / 1000));
  return <>{seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}</>;
}

export const RunTimeline = memo(function RunTimeline({
  run,
  onOpenAgent,
  onOpenFile,
  onOpenReview,
  onStopCommand,
  onOpenPlan,
  plans,
  questions = [],
  onTextFrame
}: {
  run: Run;
  onOpenAgent?: (childSessionId: string, delegationId: string, title?: string) => void;
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
  onStopCommand: (commandId: string) => void;
  onOpenPlan: (runId: string, callId: string) => void;
  plans: Plan[];
  questions?: Question[];
  onTextFrame?: () => void;
}) {
  const active = !isRunDone(run.status);
  // 投影(projectDisplayTimeline / projectResponsesDisplayTimeline / 拆轮次)只依赖 run,合并进一个
  // useMemo。历史(已完成)run 在 run 引用稳定后(reducer 结构性共享,见后续 A 方案)整段跳过;
  // 活跃 run 每个 SSE 事件 run 引用都变 → 照常重算(正确)。latestPlanByCallId 把每条目的
  // plans.filter().sort()[0] 换成一次性建表 + O(1) 查表,无论 memo 是否生效都立刻减负。
  const { displayActivities, conversationTurns, activeDisplaySegmentId } = useMemo(() => {
    const suppressedContentActivityIds = new Set(active
      ? []
      : run.activities
          .filter((activity) => activity.kind === "message" && activity.body.trim() === run.answer.trim())
          .map((activity) => activity.activityId));
    const displayActs = run.protocol === "responses" ? responsesDisplayActivities(run) : run.activities;
    const entries = run.protocol === "responses"
      ? projectResponsesDisplayTimeline(run, { suppressedContentActivityIds })
      : projectDisplayTimeline(run, run.activities, { suppressedContentActivityIds });
    return {
      displayActivities: displayActs,
      conversationTurns: splitTimelineIntoConversationTurns(run.runId, entries),
      activeDisplaySegmentId: run.status === "running"
        ? [...entries].reverse().find((entry) => entry.type === "display_segment")?.entryId
        : undefined
    };
  }, [run, active]);

  // 按 callId 取最高 revision 的 plan,替代每条目 plans.filter(...).sort((l,r) => r.revision - l.revision)[0]。
  const latestPlanByCallId = useMemo(() => {
    const map = new Map<string, Plan>();
    for (const plan of plans) {
      const existing = map.get(plan.callId);
      if (!existing || plan.revision > existing.revision) map.set(plan.callId, plan);
    }
    return map;
  }, [plans]);
  const questionByCallId = useMemo(() => {
    const map = new Map<string, Question>();
    for (const question of questions) map.set(question.callId, question);
    return map;
  }, [questions]);
  const [expanded, setExpanded] = useState(active);
  useEffect(() => setExpanded(active), [active]);
  return (
    <>
      {conversationTurns.map((turn, turnIndex) => {
        const initialTurn = turnIndex === 0;
        const lastTurn = turnIndex === conversationTurns.length - 1;
        const showRunStream = initialTurn || (expanded && turn.entries.length > 0) || (lastTurn && !active);
        return (
          <div className="conversation-turn" key={turn.turnId}>
            {initialTurn
              ? <section className="user-turn"><p>{run.prompt}</p></section>
              : turn.userMessage && (
                <ActivityView
                  activity={turn.userMessage.activity}
                  onOpenFile={onOpenFile}
                  onOpenPlan={onOpenPlan}
                  onTextFrame={onTextFrame}
                  runActive={active}
                />
              )}
            {showRunStream && (
              <div className={`run-stream ${active ? "" : "completed-stream"}`}>
                {initialTurn && (
                  <button
                    aria-expanded={expanded}
                    className={`run-status-pill ${active ? "is-live" : ""} ${expanded ? "is-expanded" : ""}`}
                    onClick={() => setExpanded((value) => !value)}
                    type="button"
                  >
                    <span>{active
                      ? (run.status === "waiting" ? "等待批准" : "正在工作")
                      : run.status === "completed" ? "工作完成" : run.status === "cancelled" ? "已取消" : "工作失败"}</span>
                    <span
                      className={`run-protocol-label is-${run.protocol === "responses" ? "responses" : "chat"}`}
                      title={run.protocol === "responses"
                        ? "此任务使用 Responses 新执行流"
                        : run.protocol === "chat" ? "此任务使用 Chat 经典执行流" : "此历史任务未记录协议，按 Chat 经典执行流展示"}
                    >
                      {run.protocol === "responses"
                        ? "新执行流 · Responses"
                        : run.protocol === "chat" ? "经典执行流 · Chat" : "历史执行流 · Chat"}
                    </span>
                    <span><RunElapsed active={active} finishedAt={run.finishedAt} startedAt={run.startedAt} /></span>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                )}
                {expanded && turn.entries.length > 0 && (
                  <section className="work-process" aria-label="工作过程">
                    {turn.entries.map((entry) => {
                      if (entry.type === "display_segment") {
                        const SegmentRenderer = run.protocol === "responses"
                          ? ResponsesDisplaySegmentRenderer
                          : DisplaySegmentRenderer;
                        return (
                          <SegmentRenderer
                            activities={displayActivities}
                            changes={run.changes}
                            continuationActive={entry.entryId === activeDisplaySegmentId}
                            key={entry.entryId}
                            onOpenFile={onOpenFile}
                            onOpenAgent={onOpenAgent ?? (() => undefined)}
                            onStopCommand={onStopCommand}
                            onTextFrame={onTextFrame}
                            runActive={active}
                            segment={entry.segment}
                          />
                        );
                      }
                      const planCallId = entry.activity.tool?.callId;
                      return (
                        <ActivityView
                          activity={entry.activity}
                          key={entry.entryId}
                          onOpenFile={onOpenFile}
                          onOpenPlan={onOpenPlan}
                          onTextFrame={onTextFrame}
                          plan={planCallId ? latestPlanByCallId.get(planCallId) : undefined}
                          question={planCallId ? questionByCallId.get(planCallId) : undefined}
                          runActive={active}
                        />
                      );
                    })}
                  </section>
                )}
                {lastTurn && !active && Boolean((run.status === "failed" ? run.error : run.answer) || run.error) && (
                  <section className="final-answer">
                    <MarkdownContent
                      citations={[...run.activities].reverse().find((activity) => activity.kind === "message")?.citations}
                      text={(run.status === "failed" ? run.error : undefined) || run.answer || run.error || ""}
                    />
                  </section>
                )}
                {lastTurn && !active && <ChangePanel delta={run.changes} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});
