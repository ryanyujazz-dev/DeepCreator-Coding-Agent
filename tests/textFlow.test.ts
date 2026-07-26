import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_FADE_FRAMES,
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
  assert.equal(streamFrameQuota(12), 2);
  assert.equal(streamFrameQuota(48), 6);
  assert.equal(streamFrameQuota(180), 23);
  assert.equal(streamFrameQuota(500), 63);
  assert.ok(streamFrameQuota(1_200) > streamFrameQuota(500));
  assert.ok(streamFrameQuota(100_000) <= 64);
});

test("batches ordinary output without delaying large backlogs", () => {
  assert.equal(streamReleaseInterval(12), 24);
  assert.equal(streamReleaseInterval(48), 16);
  assert.equal(streamReleaseInterval(180), 0);
});
