import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_FADE_FRAMES,
  STREAM_TAIL_GRAPHMES,
  advanceStreamFrame,
  fragmentOpacity,
  splitGraphemes,
  streamFrameQuota,
  streamReleaseInterval
} from "../src/stream/textFlow";

test("keeps a released fragment visible for exactly five fade frames", () => {
  let frame = advanceStreamFrame({ fragments: [], stable: "" }, "你", 1);
  assert.equal(frame.fragments[0]?.frame, 1);
  assert.equal(fragmentOpacity(frame.fragments[0]!.frame), 0.2);

  for (let index = 2; index <= STREAM_FADE_FRAMES; index += 1) {
    frame = advanceStreamFrame(frame, "", index);
    assert.equal(frame.fragments[0]?.frame, index);
  }

  assert.equal(fragmentOpacity(frame.fragments[0]!.frame), 1);
  frame = advanceStreamFrame(frame, "", 6);
  assert.deepEqual(frame, { fragments: [], stable: "你" });
});

test("segments streamed text by grapheme rather than UTF-16 code unit", () => {
  assert.deepEqual(splitGraphemes("你好👨‍💻e\u0301"), ["你", "好", "👨‍💻", "e\u0301"]);
});

test("keeps streamed presentation within a bounded visual backlog", () => {
  // 尾端(pending ≤ STREAM_TAIL_GRAPHMES)一次清空:最后几个字不等节流,立即放出,杜绝收尾卡顿。
  assert.equal(streamFrameQuota(3), 3);
  assert.equal(streamFrameQuota(STREAM_TAIL_GRAPHMES), STREAM_TAIL_GRAPHMES);
  // 中段/突发:匀速节流配额(ceil(n/8),封顶 64),保留打字机平滑、防刷屏。
  assert.equal(streamFrameQuota(48), 6);
  assert.equal(streamFrameQuota(180), 23);
  assert.equal(streamFrameQuota(500), 63);
  assert.ok(streamFrameQuota(1_200) > streamFrameQuota(500));
  assert.ok(streamFrameQuota(100_000) <= 64);
});

test("releases the tail instantly while batching mid-stream output", () => {
  // 尾端即时:pending 少(content 收尾 / 到达稀疏)→ 每帧释放(0 间隔),不等 24ms 节奏 → 根治「最后几个字卡一下」。
  assert.equal(streamReleaseInterval(3), 0);
  assert.equal(streamReleaseInterval(12), 0);
  // 中段节流:匀速打字机。
  assert.equal(streamReleaseInterval(48), 16);
  // 突发积压:每帧赶进度。
  assert.equal(streamReleaseInterval(180), 0);
});
