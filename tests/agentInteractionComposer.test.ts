import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Question } from "../shared/contracts/runtime";
import { AgentInteractionComposer } from "../src/components/AgentInteractionComposer";
import { questionHistoryRows } from "../src/components/ActivityView";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const noOp = () => undefined;

function renderQuestion(question: Question): string {
  return renderToStaticMarkup(createElement(AgentInteractionComposer, {
    accessMode: "request_approval",
    onAnswerQuestion: noOp,
    onInterruptQuestion: async () => false,
    onResolveApproval: noOp,
    onResolvePlan: noOp,
    question
  }));
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    callId: "call_question",
    createdAt: "2026-08-11T00:00:00.000Z",
    interactionId: "question_1",
    prompts: [{
      options: [
        { optionId: "first", title: "第一个选项" },
        { optionId: "second", title: "第二个选项" }
      ],
      prompt: "模型生成的问题标题",
      questionId: "choice",
      type: "single_choice"
    }],
    runId: "run_1",
    sessionId: "session_1",
    status: "pending",
    ...overrides
  };
}

test("plan entry uses fixed copy without custom input or collapse affordance", () => {
  const html = renderQuestion(makeQuestion({
    prompts: [{
      options: [
        { optionId: "enter_plan", title: "进入计划模式" },
        { optionId: "continue_work", title: "继续工作模式" }
      ],
      prompt: "模型输入的计划理由",
      questionId: "plan_entry",
      type: "single_choice"
    }],
    purpose: "plan_entry"
  }));
  assert.match(html, /是否进入计划模式？/);
  assert.doesNotMatch(html, /模型输入的计划理由/);
  assert.doesNotMatch(html, />其他</);
  assert.doesNotMatch(html, /收起问题/);
});

test("legacy plan entry without purpose still omits custom input", () => {
  const html = renderQuestion(makeQuestion({
    prompts: [{
      options: [
        { optionId: "enter_plan", title: "进入计划模式" },
        { optionId: "continue_work", title: "继续工作模式" }
      ],
      prompt: "旧版模型理由",
      questionId: "plan_entry",
      type: "single_choice"
    }]
  }));
  assert.match(html, /是否进入计划模式？/);
  assert.doesNotMatch(html, />其他</);
  assert.doesNotMatch(html, /输入自己的答案/);
});

test("ordinary clarification retains the engine-provided custom answer row", () => {
  const html = renderQuestion(makeQuestion({ purpose: "clarification" }));
  assert.match(html, /agent-interaction-shell is-expanded question-interaction/);
  assert.match(html, /agent-interaction-expandable/);
  assert.match(html, /agent-interaction-panel/);
  assert.match(html, /模型生成的问题标题/);
  assert.match(html, />其他</);
  assert.match(html, /输入自己的答案/);
  assert.match(html, /收起问题/);
});

test("answered ask_user history resolves option titles and custom answers", () => {
  const question = makeQuestion({
    answers: {
      choice: {
        status: "answered",
        answer: { kind: "choice", optionIds: ["first"], customText: "补充约束" }
      }
    },
    status: "answered"
  });
  assert.deepEqual(questionHistoryRows(question), [{
    answer: "第一个选项、补充约束",
    question: "模型生成的问题标题"
  }]);
});
