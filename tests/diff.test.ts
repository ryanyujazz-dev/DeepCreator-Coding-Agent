import assert from "node:assert/strict";
import test from "node:test";
import { generateUnifiedDiff } from "../server/infra/tools/diff";

test("单行修改生成 @@ hunk + 3 行上下文", () => {
  const diff = generateUnifiedDiff("f.txt", "a\nb\nc", "a\nB\nc");
  assert.match(diff, /--- a\/f\.txt/);
  assert.match(diff, /\+\+\+ b\/f\.txt/);
  assert.match(diff, /@@ -1,3 \+1,3 @@/);
  assert.match(diff, /-b/);
  assert.match(diff, /\+B/);
  assert.match(diff, / a/);
  assert.match(diff, / c/);
});

test("新增行(空 before)全为 +", () => {
  const diff = generateUnifiedDiff("f.txt", "", "x\ny");
  assert.match(diff, /\+x/);
  assert.match(diff, /\+y/);
  assert.doesNotMatch(diff, /^-/m);
});

test("删除行(空 after)全为 -", () => {
  const diff = generateUnifiedDiff("f.txt", "x\ny", "");
  assert.match(diff, /-x/);
  assert.match(diff, /-y/);
});

test("无变化 → 空字符串", () => {
  assert.equal(generateUnifiedDiff("f.txt", "a\nb", "a\nb"), "");
});

test("大文件(>2000 行)省略 diff", () => {
  const big = `${"x\n".repeat(2001)}`;
  const diff = generateUnifiedDiff("f.txt", big, `${big}y\n`);
  assert.match(diff, /过大,已省略 diff/);
});

test("trailingNewline 不影响 diff 行数", () => {
  const diff1 = generateUnifiedDiff("f.txt", "a\nb", "a\nB");
  const diff2 = generateUnifiedDiff("f.txt", "a\nb\n", "a\nB\n");
  // 两者 diff 结构相同(都是改第 2 行)
  assert.match(diff1, /-b/);
  assert.match(diff2, /-b/);
});
