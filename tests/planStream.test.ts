import assert from "node:assert/strict";
import test from "node:test";
import { PlanArgumentStream } from "../server/app/planStream";

function decode(chunks: string[]): { markdown: string; title: string } {
  const stream = new PlanArgumentStream();
  let markdown = "";
  let title = "";
  for (const chunk of chunks) {
    const update = stream.push(chunk);
    if (update.title !== undefined) title = update.title;
    if (update.markdownDelta) markdown += update.markdownDelta;
  }
  return { markdown, title };
}

test("decodes submit_plan strings across every two-chunk boundary", () => {
  const title = "执行流内嵌 \"计划\"";
  const markdown = "# 目标\n\n读取 `src/App.tsx`\\路径，然后实施。";
  const raw = JSON.stringify({ markdown, title });
  for (let split = 0; split <= raw.length; split += 1) {
    assert.deepEqual(decode([raw.slice(0, split), raw.slice(split)]), { markdown, title }, `split ${split}`);
  }
});

test("decodes one-character chunks and unicode escapes without leaking JSON syntax", () => {
  const raw = '{"title":"\\u8ba1\\u5212","markdown":"A\\nB \\u4e2d\\u6587 \\ud83d\\ude00"}';
  assert.deepEqual(decode([...raw]), { markdown: "A\nB 中文 😀", title: "计划" });
});
