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
