import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, emptyChanges, Run } from "../shared/contracts/runtime";
import { RunTimeline, splitTimelineIntoConversationTurns } from "../src/components/RunTimeline";
import { projectDisplayTimeline } from "../shared/projections/displaySegments";

const at = "2026-07-27T02:00:00.000Z";

function activity(activityId: string, kind: Activity["kind"], body: string): Activity {
  return {
    activityId,
    audience: "user",
    body,
    finishedAt: at,
    kind,
    runId: "run_steered",
    startedAt: at,
    status: "completed"
  };
}

function makeRun(): Run {
  return {
    activities: [
      activity("message_before", "message", "引导前的回答"),
      activity("steer", "user_message", "先检查接口，不要继续改 UI"),
      activity("message_after", "message", "收到，我先检查接口")
    ],
    answer: "",
    approvals: [],
    changes: emptyChanges(),
    lastOffset: 6,
    mode: "work",
    model: "test-model",
    prompt: "实现功能",
    runId: "run_steered",
    sessionId: "session_steered",
    startedAt: at,
    status: "running",
    tasks: []
  };
}

test("splits execution process around in-run user guidance", () => {
  const turns = splitTimelineIntoConversationTurns("run_steered", projectDisplayTimeline(makeRun()));

  assert.equal(turns.length, 2);
  assert.equal(turns[0].userMessage, undefined);
  assert.equal(turns[0].entries.length, 1);
  assert.equal(turns[1].userMessage?.activity.kind, "user_message");
  assert.equal(turns[1].entries.length, 1);
});

test("renders guidance as a conversation-level user turn between agent process sections", () => {
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    onOpenFile: () => undefined,
    onOpenPlan: () => undefined,
    onOpenReview: () => undefined,
    onStopCommand: () => undefined,
    plans: [],
    run: makeRun()
  }));

  assert.equal(html.match(/class="conversation-turn"/gu)?.length, 2);
  assert.equal(html.match(/class="work-process"/gu)?.length, 2);
  assert.match(
    html,
    /引导前的回答[\s\S]*<\/div><\/div><div class="conversation-turn"><article class="user-turn steer-user-turn"><p>先检查接口，不要继续改 UI<\/p><\/article><div class="run-stream "><section class="work-process"[\s\S]*收到，我先检查接口/u
  );
});

test("keeps guidance in the conversation after the completed process collapses", () => {
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    onOpenFile: () => undefined,
    onOpenPlan: () => undefined,
    onOpenReview: () => undefined,
    onStopCommand: () => undefined,
    plans: [],
    run: {
      ...makeRun(),
      answer: "已按引导检查接口。",
      finishedAt: "2026-07-27T02:01:00.000Z",
      status: "completed"
    }
  }));

  assert.doesNotMatch(html, /class="work-process"/u);
  assert.match(html, /class="user-turn steer-user-turn"><p>先检查接口，不要继续改 UI<\/p>/u);
  assert.match(html, /已按引导检查接口。/u);
});
