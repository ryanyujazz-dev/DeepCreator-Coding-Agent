import assert from "node:assert/strict";
import test from "node:test";
import { ModelStepStream } from "../server/app/modelStepStream";

test("batches short reasoning until a semantic stream boundary", () => {
  const reasoning: string[] = [];
  const thinking: string[] = [];
  let ended = 0;
  const stream = new ModelStepStream({
    appendAnswer: () => undefined,
    appendReasoning: (text) => reasoning.push(text),
    appendThinking: (text) => thinking.push(text),
    endThinking: () => { ended += 1; },
    startVisibleStage: () => undefined
  });
  stream.push({ kind: "thinking", text: "检查" });
  stream.push({ kind: "thinking", text: "入口" });
  assert.deepEqual(reasoning, []);
  stream.push({ argumentsText: "{}", callId: "call_1", index: 0, kind: "tool_call", name: "read_file" });
  assert.deepEqual(thinking, ["检查", "入口"]);
  assert.deepEqual(reasoning, ["检查入口"]);
  assert.equal(ended, 1);
});

test("publishes the first answer fragment immediately and flushes the tail", () => {
  const answers: Array<{ first: boolean; text: string }> = [];
  const stream = new ModelStepStream({
    appendAnswer: (text, first) => answers.push({ first, text }),
    appendReasoning: () => undefined,
    appendThinking: () => undefined,
    endThinking: () => undefined,
    startVisibleStage: () => undefined
  });
  stream.push({ kind: "answer", text: "第一段" });
  stream.push({ kind: "answer", text: "尾部" });
  assert.deepEqual(answers, [{ first: true, text: "第一段" }]);
  stream.finish();
  assert.deepEqual(answers, [
    { first: true, text: "第一段" },
    { first: false, text: "尾部" }
  ]);
});

test("answer 攒满 ANSWER_FLUSH_CHARS(8)立即同步 flush,不等定时器/tool_call", () => {
  const answers: Array<{ first: boolean; text: string }> = [];
  const stream = new ModelStepStream({
    appendAnswer: (text, first) => answers.push({ first, text }),
    appendReasoning: () => undefined,
    appendThinking: () => undefined,
    endThinking: () => undefined,
    startVisibleStage: () => undefined
  });
  stream.push({ kind: "answer", text: "首" }); // firstFragment 立即 flush
  stream.push({ kind: "answer", text: "二三四五六七" }); // 6 字,累积 < 8,进 buffer + 设定时器
  // 同步检查:setTimeout 是 macrotask 尚未触发 → 确认 < 阈值时不会同步 flush
  assert.equal(answers.length, 1);
  stream.push({ kind: "answer", text: "八九" }); // 累积 8,>= 阈值,立即【同步】flush
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[1], { first: false, text: "二三四五六七八九" });
});

test("answer 含换行立即同步 flush(即使未到阈值)", () => {
  const answers: Array<{ first: boolean; text: string }> = [];
  const stream = new ModelStepStream({
    appendAnswer: (text, first) => answers.push({ first, text }),
    appendReasoning: () => undefined,
    appendThinking: () => undefined,
    endThinking: () => undefined,
    startVisibleStage: () => undefined
  });
  stream.push({ kind: "answer", text: "首" });
  stream.push({ kind: "answer", text: "短\n" }); // 仅 2 字但含换行,立即同步 flush
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[1], { first: false, text: "短\n" });
});

test("reasoning 用更大阈值:短增量不 flush,攒满 REASONING_FLUSH_CHARS(48)才同步 flush", () => {
  const reasoning: string[] = [];
  const stream = new ModelStepStream({
    appendAnswer: () => undefined,
    appendReasoning: (text) => reasoning.push(text),
    appendThinking: () => undefined,
    endThinking: () => undefined,
    startVisibleStage: () => undefined
  });
  // thinking → bufferReasoning。REASONING_FLUSH_CHARS(48)远大于 answer 的 8,
  // 故 reasoning 不会像 answer 那样高频 flush(避免长思维链放大 per-event sessions.save)。
  stream.push({ kind: "thinking", text: "思".repeat(40) }); // 40 < 48,buffer + 设定时器
  assert.deepEqual(reasoning, []);
  stream.push({ kind: "thinking", text: "思".repeat(8) }); // 累积 48,同步 flush
  assert.deepEqual(reasoning, ["思".repeat(48)]);
});
