import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editFile } from "../server/infra/tools/files";

function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "edit-tolerant-"));
  return work(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as { code?: string }).code === "EPERM" && process.platform === "win32")) throw error;
    }
  });
}

test("editFile: strict 命中完全向后兼容", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "f.txt"), "hello world");
    const result = await editFile(dir, { path: "f.txt", oldText: "hello", newText: "hi" });
    assert.match(result, /已编辑/);
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "hi world");
  });
});

test("editFile: relaxed trimEnd 容错命中(strict=0 时降级)", async () => {
  await withDir(async (dir) => {
    // 文件行无尾随空格,oldText 含尾随空格 → strict 子串 0(空格不匹配),降级 relaxed 行匹配命中
    writeFileSync(join(dir, "f.txt"), "line1\nline2\nline3");
    await editFile(dir, { path: "f.txt", oldText: "line2   ", newText: "replaced" });
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "line1\nreplaced\nline3");
  });
});

test("editFile: 未找到时报错带附近相似行提示", async () => {
  await withDir(async (dir) => {
    // oldText 不在文件(strict 0,relaxed 行也不等),但文件有相似行 → nearestLine 命中
    writeFileSync(join(dir, "f.txt"), "a\nxyz-like\nb");
    await assert.rejects(
      editFile(dir, { path: "f.txt", oldText: "xyz-like-extra", newText: "y" }),
      (error: Error) => /未在 f\.txt 中找到 oldText/.test(error.message) && /相似内容/.test(error.message)
    );
  });
});

test("editFile: 未找到时报错含附近实际行原文 + oldText 首行(失败自纠正)", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "f.txt"), "alpha\nbeta gamma\ndelta\nepsilon");
    await assert.rejects(
      editFile(dir, { path: "f.txt", oldText: "beta gammax", newText: "x" }), // 含相似前缀,触发 nearestLine 子串命中
      (error: Error) =>
        /未在 f\.txt 中找到 oldText/.test(error.message)
        && /期望 oldText 首行: beta gammax/.test(error.message)
        && /附近实际行原文/.test(error.message)
        && /2: beta gamma/.test(error.message) // 命中行(1-indexed)的实际原文
    );
  });
});

test("editFile: oldText 空 → 提示用 write_file", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "f.txt"), "x");
    await assert.rejects(
      editFile(dir, { path: "f.txt", oldText: "", newText: "y" }),
      /oldText 不能为空.*write_file/
    );
  });
});
