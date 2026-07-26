import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Run, emptyChanges } from "../shared/contracts/runtime";
import { ReasoningTrace } from "../src/components/ReasoningTrace";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    activities: [],
    answer: "",
    approvals: [],
    changes: emptyChanges(),
    lastOffset: 2,
    mode: "work",
    model: "test-model",
    prompt: "测试推理展示",
    reasoning: "先定位相关内容。\n\n再检查实现细节。",
    reasoningSteps: [
      { modelStepId: "model_step_1", text: "先定位相关内容。" },
      { modelStepId: "model_step_2", text: "再检查实现细节。" }
    ],
    runId: "run_reasoning",
    sessionId: "session_reasoning",
    startedAt: "2026-07-26T05:00:00.000Z",
    status: "running",
    tasks: [],
    ...overrides
  };
}

test("expands and exposes the reasoning trace while a run is active", () => {
  const html = renderToStaticMarkup(createElement(ReasoningTrace, { run: makeRun() }));

  assert.match(html, /正在思考/);
  assert.match(html, /reasoning-title-transition/);
  assert.match(html, /purpose-sweep/);
  assert.match(html, /实时/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /reasoning-trace is-streaming/);
  assert.match(html, /思考步骤 1/);
  assert.match(html, /思考步骤 2/);
  assert.match(html, /data-model-step-id="model_step_1"/);
  assert.match(html, /data-model-step-id="model_step_2"/);
  assert.equal(html.match(/class="reasoning-step/g)?.length, 2);
  assert.match(html, /先定位相关内容。/);
  assert.match(html, /再检查实现细节。/);
});

test("starts collapsed after the run reaches a terminal state", () => {
  const html = renderToStaticMarkup(createElement(ReasoningTrace, { run: makeRun({
    finishedAt: "2026-07-26T05:01:00.000Z",
    reasoningTitle: "核对页面跳转参数",
    status: "completed"
  }) }));

  assert.match(html, /核对页面跳转参数/);
  assert.match(html, /已完成/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /purpose-sweep/);
  assert.doesNotMatch(html, /reasoning-trace/);
  assert.doesNotMatch(html, /先定位相关内容。/);
});

test("does not reserve inspector space before reasoning arrives", () => {
  const html = renderToStaticMarkup(createElement(ReasoningTrace, {
    run: makeRun({ reasoning: undefined, reasoningSteps: undefined })
  }));

  assert.equal(html, "");
});

test("does not invent one Run-level node for legacy aggregate reasoning", () => {
  const html = renderToStaticMarkup(createElement(ReasoningTrace, {
    run: makeRun({ reasoning: "历史思考内容", reasoningSteps: undefined })
  }));

  assert.equal(html, "");
});

test("keeps failed and cancelled terminal labels truthful", () => {
  const failed = renderToStaticMarkup(createElement(ReasoningTrace, { run: makeRun({ status: "failed" }) }));
  const cancelled = renderToStaticMarkup(createElement(ReasoningTrace, { run: makeRun({ status: "cancelled" }) }));

  assert.match(failed, /已失败/);
  assert.match(cancelled, /已取消/);
  assert.match(failed, /aria-expanded="false"/);
  assert.match(cancelled, /aria-expanded="false"/);
});

test("renders the persisted reasoning title with a polite live region", () => {
  const html = renderToStaticMarkup(createElement(ReasoningTrace, {
    run: makeRun({ reasoningTitle: "检查接口异常处理" })
  }));

  assert.match(html, /检查接口异常处理/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.doesNotMatch(html, />思考过程</);
});
