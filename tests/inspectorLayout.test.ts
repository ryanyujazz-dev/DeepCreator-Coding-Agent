import assert from "node:assert/strict";
import test from "node:test";
import { resolveCompactSidebar, resolveInspectorLayout } from "../src/inspectorLayout";

test("centers the conversation when the inspector cannot collide", () => {
  assert.equal(resolveInspectorLayout(1820), "centered");
});

test("reserves the corridor when the full inspector approaches the conversation", () => {
  assert.equal(resolveInspectorLayout(1480), "reserved");
});

test("collapses the inspector before the safe corridor reaches the conversation minimum", () => {
  assert.equal(resolveInspectorLayout(1000), "compact");
});

test("uses hysteresis around the centered boundary", () => {
  assert.equal(resolveInspectorLayout(1655, "centered"), "centered");
  assert.equal(resolveInspectorLayout(1655, "reserved"), "reserved");
  assert.equal(resolveInspectorLayout(1700, "reserved"), "centered");
});

test("uses hysteresis around the compact boundary", () => {
  assert.equal(resolveInspectorLayout(1090, "compact"), "compact");
  assert.equal(resolveInspectorLayout(1090, "reserved"), "reserved");
  assert.equal(resolveInspectorLayout(1040, "reserved"), "compact");
});

test("collapses the sidebar after the compact inspector reaches its staged minimum", () => {
  assert.equal(resolveCompactSidebar(900, 272), true);
  assert.equal(resolveCompactSidebar(1100, 272), false);
});

test("uses hysteresis when restoring the responsive sidebar", () => {
  assert.equal(resolveCompactSidebar(950, 272, true), true);
  assert.equal(resolveCompactSidebar(950, 272, false), false);
  assert.equal(resolveCompactSidebar(980, 272, true), false);
});
