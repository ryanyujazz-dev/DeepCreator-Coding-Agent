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

test("raises the per-frame quota as presentation backlog grows", () => {
  assert.equal(streamFrameQuota(12), 1);
  assert.equal(streamFrameQuota(48), 1);
  assert.equal(streamFrameQuota(180), 2);
  assert.equal(streamFrameQuota(500), 4);
  assert.ok(streamFrameQuota(1_200) > streamFrameQuota(500));
  assert.ok(streamFrameQuota(100_000) <= 24);
});

test("paces ordinary output while allowing a large backlog to catch up", () => {
  assert.equal(streamReleaseInterval(48), 28);
  assert.equal(streamReleaseInterval(180), 20);
  assert.equal(streamReleaseInterval(600), 0);
});
