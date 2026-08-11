import assert from "node:assert/strict";
import test from "node:test";
import { locateLineMatches, splitLines, joinLines, nearestLine } from "../server/infra/tools/textMatch";

test("splitLines/joinLines 保留 trailingNewline", () => {
  const { lines, trailingNewline } = splitLines("a\nb\n");
  assert.deepEqual(lines, ["a", "b"]);
  assert.equal(trailingNewline, true);
  assert.equal(joinLines(lines, trailingNewline), "a\nb\n");
  const no = splitLines("a\nb");
  assert.equal(no.trailingNewline, false);
  assert.equal(joinLines(no.lines, false), "a\nb");
});

test("splitLines 归一化 \\r\\n", () => {
  const { lines } = splitLines("a\r\nb\r\n");
  assert.deepEqual(lines, ["a", "b"]);
});

test("locateLineMatches: strict 命中", () => {
  const result = locateLineMatches(["line1", "line2", "line3"], ["line2"]);
  assert.deepEqual(result.strict, [1]);
  assert.deepEqual(result.relaxed, [1]);
});

test("locateLineMatches: strict=0 relaxed trimEnd 命中", () => {
  // source 有尾随空格,pattern 无 → strict 0,relaxed 命中
  const result = locateLineMatches(["line2   "], ["line2"]);
  assert.deepEqual(result.strict, []);
  assert.deepEqual(result.relaxed, [0]);
});

test("locateLineMatches: strict 多匹配(relaxed 也多)", () => {
  const result = locateLineMatches(["foo", "foo", "bar"], ["foo"]);
  assert.deepEqual(result.strict, [0, 1]);
  assert.deepEqual(result.relaxed, [0, 1]);
});

test("locateLineMatches: window 限定范围", () => {
  const result = locateLineMatches(["foo", "bar", "foo"], ["foo"], { from: 2, to: 2 });
  assert.deepEqual(result.strict, [2]);
});

test("locateLineMatches: 窗口内 0 命中(全局有)", () => {
  const result = locateLineMatches(["foo", "bar", "foo"], ["foo"], { from: 1, to: 1 });
  assert.deepEqual(result.strict, []);
});

test("nearestLine: 精确命中返回行号", () => {
  assert.equal(nearestLine(["a", "foo", "b"], "foo\nrest"), 1);
});

test("nearestLine: 无匹配返回 -1", () => {
  assert.equal(nearestLine(["a", "b"], "xyz"), -1);
});
