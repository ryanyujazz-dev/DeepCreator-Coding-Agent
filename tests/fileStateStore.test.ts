import assert from "node:assert/strict";
import test from "node:test";
import { FileStateStore } from "../server/app/fileStateStore";
import { stableDigest } from "../shared/domain/digest";

test("recordRead + hashFor 返回全文 hash", () => {
  const store = new FileStateStore();
  store.recordRead("run1", "/root", "src/f.ts", "hello");
  assert.equal(store.hashFor("run1", "/root", "src/f.ts"), stableDigest("hello"));
});

test("hashFor 无记录 → undefined（不校验，不强制 read）", () => {
  const store = new FileStateStore();
  assert.equal(store.hashFor("run1", "/root", "src/f.ts"), undefined);
});

test("runId 空 → 全跳过（兼容单测无 runId）", () => {
  const store = new FileStateStore();
  store.recordRead(undefined, "/root", "f", "x");
  assert.equal(store.hashFor(undefined, "/root", "f"), undefined);
  store.recordWrite(undefined, "/root", "f", "y");
});

test("recordWrite 更新 hash（edit/write 后同步）", () => {
  const store = new FileStateStore();
  store.recordRead("run1", "/root", "f", "hello");
  const before = store.hashFor("run1", "/root", "f");
  store.recordWrite("run1", "/root", "f", "world");
  assert.notEqual(store.hashFor("run1", "/root", "f"), before);
  assert.equal(store.hashFor("run1", "/root", "f"), stableDigest("world"));
});

test("clear 清理 runId", () => {
  const store = new FileStateStore();
  store.recordRead("run1", "/root", "f", "x");
  store.clear("run1");
  assert.equal(store.hashFor("run1", "/root", "f"), undefined);
});

test("不同 runId 独立（subagent 各自 map）", () => {
  const store = new FileStateStore();
  store.recordRead("run1", "/root", "f", "a");
  assert.equal(store.hashFor("run2", "/root", "f"), undefined);
});

test("hash 全文（非截断切片）—— read 切片 40K 但 hash 全文，保证 read→edit 可比", () => {
  const store = new FileStateStore();
  const full = "x".repeat(100_000);
  store.recordRead("run1", "/root", "f", full);
  assert.equal(store.hashFor("run1", "/root", "f"), stableDigest(full));
});
