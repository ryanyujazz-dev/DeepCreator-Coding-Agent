import assert from "node:assert/strict";
import test from "node:test";
import { Question } from "../shared/contracts/runtime";
import {
  normalizeQuestionAnswers,
  normalizeQuestionPrompt,
  validateQuestionAnswers,
  validateQuestionPrompt
} from "../shared/domain/questions";

test("normalizes legacy questions without rewriting persisted values", () => {
  const question: Question = {
    callId: "call_legacy",
    createdAt: "2026-08-10T00:00:00.000Z",
    interactionId: "question_legacy",
    prompts: [{ label: "方案", options: ["方案 A", "方案 B"], prompt: "选择方案", questionId: "choice" }],
    runId: "run_legacy",
    sessionId: "session_legacy",
    status: "answered",
    answers: { choice: "方案 B" }
  };
  const prompt = normalizeQuestionPrompt(question.prompts[0]);
  assert.equal(prompt.type, "single_choice");
  assert.deepEqual(prompt.options.map((option) => option.optionId), ["option_1", "option_2"]);
  assert.deepEqual(normalizeQuestionAnswers(question), {
    choice: { status: "answered", answer: { kind: "choice", optionIds: ["option_2"] } }
  });
});

test("validates recommendations and multiple-choice selection bounds", () => {
  const prompt = normalizeQuestionPrompt({
    maxSelections: 2,
    minSelections: 1,
    options: [
      { optionId: "code", title: "代码实现", recommended: true },
      { optionId: "review", title: "审查测试", recommended: true }
    ],
    prompt: "接下来做什么？",
    questionId: "next_step",
    type: "multiple_choice"
  });
  assert.equal(validateQuestionPrompt(prompt), undefined);
  const question: Question = {
    callId: "call_multi",
    createdAt: "2026-08-10T00:00:00.000Z",
    interactionId: "question_multi",
    prompts: [prompt],
    runId: "run_multi",
    sessionId: "session_multi",
    status: "pending"
  };
  assert.equal(validateQuestionAnswers(question, {
    next_step: { status: "answered", answer: { kind: "choice", optionIds: ["code", "review"] } }
  }), undefined);
  assert.match(validateQuestionAnswers(question, {
    next_step: { status: "answered", answer: { kind: "choice", optionIds: ["code", "review"], customText: "其他" } }
  }) ?? "", /需要选择 1 至 2 项/);
});

test("allows questions and recommendations to remain optional", () => {
  assert.equal(validateQuestionPrompt(normalizeQuestionPrompt({
    options: [{ optionId: "a", title: "A" }, { optionId: "b", title: "B" }],
    prompt: "请选择",
    questionId: "choice",
    type: "single_choice"
  })), undefined);
  assert.equal(validateQuestionPrompt(normalizeQuestionPrompt({
    placeholder: "补充说明",
    prompt: "还有哪些约束？",
    questionId: "constraints",
    type: "text"
  })), undefined);
});

test("rejects duplicate option ids, excess recommendations, and text-only field conflicts", () => {
  assert.match(validateQuestionPrompt(normalizeQuestionPrompt({
    options: [{ optionId: "same", title: "A" }, { optionId: "same", title: "B" }],
    prompt: "请选择",
    questionId: "duplicate_options",
    type: "single_choice"
  })) ?? "", /选项 ID 不能重复/);
  assert.match(validateQuestionPrompt(normalizeQuestionPrompt({
    options: [
      { optionId: "a", title: "A", recommended: true },
      { optionId: "b", title: "B", recommended: true }
    ],
    prompt: "请选择",
    questionId: "recommendations",
    type: "single_choice"
  })) ?? "", /最多推荐一个选项/);
  assert.match(validateQuestionPrompt(normalizeQuestionPrompt({
    minSelections: 1,
    prompt: "请说明",
    questionId: "text_conflict",
    type: "text"
  })) ?? "", /不能声明选项或选择数量/);
});

test("rejects unknown and out-of-range submitted choices", () => {
  const question: Question = {
    callId: "call_bounds",
    createdAt: "2026-08-10T00:00:00.000Z",
    interactionId: "question_bounds",
    prompts: [{
      maxSelections: 1,
      options: [{ optionId: "a", title: "A" }, { optionId: "b", title: "B" }],
      prompt: "请选择",
      questionId: "bounded",
      type: "multiple_choice"
    }],
    runId: "run_bounds",
    sessionId: "session_bounds",
    status: "pending"
  };
  assert.match(validateQuestionAnswers(question, {
    bounded: { status: "answered", answer: { kind: "choice", optionIds: ["unknown"] } }
  }) ?? "", /包含无效选项/);
  assert.match(validateQuestionAnswers(question, {
    bounded: { status: "answered", answer: { kind: "choice", optionIds: ["a", "b"] } }
  }) ?? "", /需要选择 1 至 1 项/);
});

test("plan entry confirmation rejects interface-level custom answers", () => {
  const question: Question = {
    callId: "call_plan_entry",
    createdAt: "2026-08-11T00:00:00.000Z",
    interactionId: "question_plan_entry",
    prompts: [{
      options: [
        { optionId: "enter_plan", title: "进入计划模式" },
        { optionId: "continue_work", title: "继续工作模式" }
      ],
      prompt: "是否进入计划模式？",
      questionId: "plan_entry",
      type: "single_choice"
    }],
    purpose: "plan_entry",
    runId: "run_plan_entry",
    sessionId: "session_plan_entry",
    status: "pending"
  };
  assert.match(validateQuestionAnswers(question, {
    plan_entry: { status: "answered", answer: { kind: "choice", optionIds: [], customText: "稍后再说" } }
  }) ?? "", /不接受自定义答案/);
});
