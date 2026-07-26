import assert from "node:assert/strict";
import test from "node:test";
import { resolveScrollFollowMode } from "../src/stream/followScroll";

test("pauses follow only after the user moves meaningfully away from the bottom", () => {
  assert.equal(resolveScrollFollowMode("follow", 60), "follow");
  assert.equal(resolveScrollFollowMode("follow", 61), "paused");
});

test("keeps history browsing stable until the user returns to the bottom", () => {
  assert.equal(resolveScrollFollowMode("paused", 8), "paused");
  assert.equal(resolveScrollFollowMode("paused", 7), "follow");
});
