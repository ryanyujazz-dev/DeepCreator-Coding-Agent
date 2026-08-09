import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathsFromApplyPatch } from "../server/domain/applyPatch";
import { applyPatch } from "../server/infra/tools/applyPatch";

test("applies add, update, delete, and move operations only after the full patch validates", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-"));
  try {
    await fs.writeFile(path.join(root, "update.txt"), "alpha\nbeta\n", "utf8");
    await fs.writeFile(path.join(root, "delete.txt"), "remove\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+new",
      "*** Update File: update.txt",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** Update File: added.txt",
      "*** Move to: nested/moved.txt",
      "@@",
      " new",
      "*** Delete File: delete.txt",
      "*** End Patch"
    ].join("\n");
    assert.deepEqual(pathsFromApplyPatch(patch), ["added.txt", "update.txt", "nested/moved.txt", "delete.txt"]);
    await applyPatch(root, { patch });
    assert.equal(await fs.readFile(path.join(root, "update.txt"), "utf8"), "alpha\ngamma\n");
    assert.equal(await fs.readFile(path.join(root, "nested/moved.txt"), "utf8"), "new\n");
    await assert.rejects(fs.access(path.join(root, "added.txt")));
    await assert.rejects(fs.access(path.join(root, "delete.txt")));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("keeps every file untouched when any hunk is invalid", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-invalid-"));
  try {
    await fs.writeFile(path.join(root, "one.txt"), "one\n", "utf8");
    await fs.writeFile(path.join(root, "two.txt"), "two\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      "-one",
      "+changed",
      "*** Update File: two.txt",
      "@@",
      "-missing",
      "+changed",
      "*** End Patch"
    ].join("\n");
    await assert.rejects(applyPatch(root, { patch }), /补丁草稿未应用/);
    assert.equal(await fs.readFile(path.join(root, "one.txt"), "utf8"), "one\n");
    assert.equal(await fs.readFile(path.join(root, "two.txt"), "utf8"), "two\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("uses @@ anchors to disambiguate repeated hunk content", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-anchor-"));
  try {
    await fs.writeFile(path.join(root, "repeated.txt"), "first()\nvalue\nsecond()\nvalue\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: repeated.txt",
      "@@ second()",
      "-value",
      "+changed",
      "*** End Patch"
    ].join("\n");
    await applyPatch(root, { patch });
    assert.equal(await fs.readFile(path.join(root, "repeated.txt"), "utf8"), "first()\nvalue\nsecond()\nchanged\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rejects ambiguous unanchored hunks instead of modifying the first match", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-ambiguous-"));
  try {
    await fs.writeFile(path.join(root, "repeated.txt"), "first()\nvalue\nsecond()\nvalue\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: repeated.txt",
      "@@",
      "-value",
      "+changed",
      "*** End Patch"
    ].join("\n");
    await assert.rejects(applyPatch(root, { patch }), /匹配多处/);
    assert.equal(await fs.readFile(path.join(root, "repeated.txt"), "utf8"), "first()\nvalue\nsecond()\nvalue\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("leaves originals untouched when a later file cannot be staged for commit", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-transaction-"));
  try {
    await fs.writeFile(path.join(root, "one.txt"), "one\n", "utf8");
    const oversizedName = `${"x".repeat(300)}.txt`;
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      "-one",
      "+changed",
      `*** Add File: ${oversizedName}`,
      "+new",
      "*** End Patch"
    ].join("\n");
    await assert.rejects(applyPatch(root, { patch }), /所有文件保持不变/);
    assert.equal(await fs.readFile(path.join(root, "one.txt"), "utf8"), "one\n");
    assert.deepEqual(await fs.readdir(root), ["one.txt"]);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rejects a move that would overwrite an existing destination", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-move-"));
  try {
    await fs.writeFile(path.join(root, "source.txt"), "source\n", "utf8");
    await fs.writeFile(path.join(root, "target.txt"), "target\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "*** Move to: target.txt",
      "@@",
      " source",
      "*** End Patch"
    ].join("\n");
    await assert.rejects(applyPatch(root, { patch }), /不能移动到已存在文件/);
    assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "source\n");
    assert.equal(await fs.readFile(path.join(root, "target.txt"), "utf8"), "target\n");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("preserves executable permissions when replacing an existing file", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-apply-patch-mode-"));
  try {
    const target = path.join(root, "script.sh");
    await fs.writeFile(target, "echo before\n", "utf8");
    await fs.chmod(target, 0o755);
    const patch = [
      "*** Begin Patch",
      "*** Update File: script.sh",
      "@@",
      "-echo before",
      "+echo after",
      "*** End Patch"
    ].join("\n");
    await applyPatch(root, { patch });
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
