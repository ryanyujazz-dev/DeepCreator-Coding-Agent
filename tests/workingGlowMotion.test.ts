import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKING_SWEEP_BEAT_MS,
  WORKING_SWEEP_SPEED_PX_PER_SECOND,
  WORKING_SWEEP_WIDTH_PX,
  workingGlowMetrics
} from "../src/workingGlowMotion";

test("uses one shared highlight width while centering it on the sentence edges", () => {
  const short = workingGlowMetrics(120);
  const long = workingGlowMetrics(360);

  assert.equal(short.influenceWidth, WORKING_SWEEP_WIDTH_PX);
  assert.equal(long.influenceWidth, WORKING_SWEEP_WIDTH_PX);
  assert.equal(short.startPosition, -WORKING_SWEEP_WIDTH_PX / 2);
  assert.equal(short.endPosition, 120 - WORKING_SWEEP_WIDTH_PX / 2);
  assert.equal(long.startPosition, -WORKING_SWEEP_WIDTH_PX / 2);
  assert.equal(long.endPosition, 360 - WORKING_SWEEP_WIDTH_PX / 2);
});

test("keeps movement speed fixed and schedules each sweep on the 1.5 second grid", () => {
  const short = workingGlowMetrics(120);
  const long = workingGlowMetrics(360);

  assert.ok(Math.abs(short.textWidth / (short.activeDurationMs / 1_000) - WORKING_SWEEP_SPEED_PX_PER_SECOND) < 0.000_001);
  assert.ok(Math.abs(long.textWidth / (long.activeDurationMs / 1_000) - WORKING_SWEEP_SPEED_PX_PER_SECOND) < 0.000_001);
  assert.equal(short.periodMs, WORKING_SWEEP_BEAT_MS);
  assert.equal(long.periodMs, WORKING_SWEEP_BEAT_MS * 2);
  assert.ok(Math.abs(short.activeDurationMs - 967.742) < 0.001);
  assert.ok(Math.abs(long.activeDurationMs - 2_903.226) < 0.001);
  assert.equal(1_500 % short.periodMs, 0);
  assert.notEqual(1_500 % long.periodMs, 0);
  assert.equal(3_000 % short.periodMs, 0);
  assert.equal(3_000 % long.periodMs, 0);
});

test("keeps exact beat boundaries in their current cadence", () => {
  const exactBeatWidth = WORKING_SWEEP_SPEED_PX_PER_SECOND * 1.5;

  assert.equal(workingGlowMetrics(exactBeatWidth).periodMs, WORKING_SWEEP_BEAT_MS);
});
