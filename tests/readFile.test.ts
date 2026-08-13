import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStateStore } from "../server/app/fileStateStore";
import { editFile, readFile } from "../server/infra/tools/files";

// read_file 工具测试:cat -n 行号、offset/limit 分页、截断标注、
//                      以及最关键的 stale 契约(行号化不得破坏 edit_file 的指纹校验)。

function fixture(content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-readfile-"));
  writeFileSync(path.join(directory, "sample.ts"), content);
  return directory;
}

const CLEANUP = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };

test("readFile: 每行带 1 起始行号(cat -n 风格)", async () => {
  const directory = fixture("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  try {
    const output = await readFile(directory, { path: "sample.ts" });
    assert.equal(output, "   1  const a = 1;\n   2  const b = 2;\n   3  const c = 3;\n");
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("readFile: offset 从指定行开始,limit 限制行数", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  const directory = fixture(`${lines.join("\n")}\n`);
  try {
    const paged = await readFile(directory, { path: "sample.ts", offset: 120, limit: 80 });
    assert.ok(paged.startsWith(" 120  line 120\n"));
    assert.ok(paged.endsWith(" 199  line 199")); // 末行无尾随换行
    assert.ok(!paged.includes("line 119"));
    assert.ok(!paged.includes("line 200"));
    const tail = await readFile(directory, { path: "sample.ts", offset: 250 });
    assert.equal(tail, ""); // 超出文件末尾 → 空
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("readFile: 超过 maxChars 时按整行截断并尾附标注", async () => {
  const lines = Array.from({ length: 500 }, () => `x`.repeat(40));
  const contents = `${lines.join("\n")}\n`;
  const directory = fixture(contents);
  try {
    const output = await readFile(directory, { path: "sample.ts", maxChars: 2000 });
    assert.match(output, /…\[已截断：原文 \d+ 字符，已返回 \d+ 字符，可用 offset\/limit 继续读取后续\]$/);
    // 截断只发生在整行边界:没有半行
    const bodyLines = output.split("\n").filter((line) => !line.startsWith("…["));
    assert.ok(bodyLines.every((line) => line.endsWith("x".repeat(40))));
    assert.ok(bodyLines.length < 500);
    assert.ok(output.length <= 2000 + 200); // 标注计入预算的宽松校验
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("readFile: 行号化不破坏 edit_file 的 stale 指纹契约", async () => {
  const directory = fixture("export const value = 1;\nexport const other = 2;\n");
  const fileState = new FileStateStore();
  const ctx = { fileState, runId: "run_stale" };
  try {
    // 读取(返回带行号)后直接编辑 —— 指纹记录的是未编号原文,编辑不得误报 stale
    const read = await readFile(directory, { path: "sample.ts" }, ctx);
    assert.match(read, /^ {3}1 {2}export const value = 1;$/m);
    const edited = await editFile(
      directory,
      { newText: "export const value = 42;", oldText: "export const value = 1;", path: "sample.ts" },
      ctx
    );
    assert.match(edited, /export const value = 42/);
    // 外部(非 Runtime)修改文件后不重读就编辑 → 应触发 stale(证明指纹仍以原文为基准工作)
    writeFileSync(path.join(directory, "sample.ts"), "export const value = 42;\nexport const hacked = true;\n");
    await assert.rejects(
      editFile(directory, { newText: "x", oldText: "export const other = 2;", path: "sample.ts" }, ctx),
      /自上次 read_file 后已被修改/
    );
  } finally {
    fileState.clear("run_stale");
    rmSync(directory, CLEANUP);
  }
});
