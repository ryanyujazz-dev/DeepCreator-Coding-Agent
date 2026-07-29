import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "../server/infra/tools";

// ─────────────────────────────────────────────────────────────────────────────
// multi_edit 工具测试。
//
// 核心保证:原子性 —— 任一 oldText 不匹配则整批回滚,文件不变。
// 测试覆盖:
//   1. 全部替换成功
//   2. 部分失败 → 整批回滚(原文件不变)
//   3. oldText 不唯一(无 replaceAll)→ 失败回滚
//   4. oldText 不唯一(有 replaceAll)→ 成功
//   5. 空 edits 数组 → 报错
//   6. 链式应用(后续 edit 看到前面 edit 的结果)
//   7. summarizeToolArguments 脱敏
// ─────────────────────────────────────────────────────────────────────────────

function setupWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "deepcreator-multi-edit-"));
}

test("multi_edit: applies all edits successfully", async () => {
  const directory = setupWorkspace();
  try {
    writeFileSync(path.join(directory, "target.ts"), "const foo = 1;\nconst bar = 2;\nconst baz = 3;\n");
    const result = await executeTool({
      args: {
        path: "target.ts",
        edits: [
          { oldText: "const foo = 1;", newText: "const foo = 10;" },
          { oldText: "const bar = 2;", newText: "const bar = 20;" }
        ]
      },
      name: "multi_edit",
      projectRoot: directory
    });
    assert.equal(result.mutatedWorkspace, true);
    assert.match(result.output, /已原子编辑/);
    const content = readFileSync(path.join(directory, "target.ts"), "utf8");
    assert.equal(content, "const foo = 10;\nconst bar = 20;\nconst baz = 3;\n");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: rolls back all changes when one edit fails (atomicity)", async () => {
  const directory = setupWorkspace();
  try {
    const original = "const foo = 1;\nconst bar = 2;\n";
    writeFileSync(path.join(directory, "target.ts"), original);
    await assert.rejects(
      executeTool({
        args: {
          path: "target.ts",
          edits: [
            { oldText: "const foo = 1;", newText: "const foo = 10;" },
            { oldText: "const NONEXISTENT = 999;", newText: "replaced" }
          ]
        },
        name: "multi_edit",
        projectRoot: directory
      }),
      /回滚/
    );
    // 原子性:文件应未被修改
    const content = readFileSync(path.join(directory, "target.ts"), "utf8");
    assert.equal(content, original);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: fails when oldText appears multiple times without replaceAll", async () => {
  const directory = setupWorkspace();
  try {
    const original = "const x = 1;\nconst x = 1;\n";
    writeFileSync(path.join(directory, "dup.ts"), original);
    await assert.rejects(
      executeTool({
        args: {
          path: "dup.ts",
          edits: [
            { oldText: "const x = 1;", newText: "const x = 2;" }
          ]
        },
        name: "multi_edit",
        projectRoot: directory
      }),
      /出现 2 次/
    );
    const content = readFileSync(path.join(directory, "dup.ts"), "utf8");
    assert.equal(content, original);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: succeeds with replaceAll for ambiguous matches", async () => {
  const directory = setupWorkspace();
  try {
    writeFileSync(path.join(directory, "dup.ts"), "const x = 1;\nconst x = 1;\n");
    await executeTool({
      args: {
        path: "dup.ts",
        edits: [
          { oldText: "const x = 1;", newText: "const y = 2;", replaceAll: true }
        ]
      },
      name: "multi_edit",
      projectRoot: directory
    });
    const content = readFileSync(path.join(directory, "dup.ts"), "utf8");
    assert.equal(content, "const y = 2;\nconst y = 2;\n");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: rejects empty edits array", async () => {
  const directory = setupWorkspace();
  try {
    writeFileSync(path.join(directory, "empty.ts"), "content\n");
    await assert.rejects(
      executeTool({
        args: { path: "empty.ts", edits: [] },
        name: "multi_edit",
        projectRoot: directory
      }),
      /不能为空/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: edits are applied sequentially (later edits see earlier results)", async () => {
  const directory = setupWorkspace();
  try {
    // 第一个 edit 把 foo=1 改成 helper(1),第二个 edit 匹配 helper(1)
    writeFileSync(path.join(directory, "chain.ts"), "const result = foo(1);\n");
    await executeTool({
      args: {
        path: "chain.ts",
        edits: [
          { oldText: "foo(1)", newText: "helper(1)" },
          { oldText: "helper(1)", newText: "helper(42)" }
        ]
      },
      name: "multi_edit",
      projectRoot: directory
    });
    const content = readFileSync(path.join(directory, "chain.ts"), "utf8");
    // 链式应用:foo(1) → helper(1) → helper(42)
    assert.equal(content, "const result = helper(42);\n");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("multi_edit: reports all failed edits in the error message", async () => {
  const directory = setupWorkspace();
  try {
    writeFileSync(path.join(directory, "multi-fail.ts"), "const a = 1;\n");
    let caught: unknown;
    try {
      await executeTool({
        args: {
          path: "multi-fail.ts",
          edits: [
            { oldText: "MISSING_1", newText: "x" },
            { oldText: "MISSING_2", newText: "y" },
            { oldText: "MISSING_3", newText: "z" }
          ]
        },
        name: "multi_edit",
        projectRoot: directory
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "expected multi_edit to throw");
    const message = caught.message;
    assert.match(message, /3 处匹配失败/);
    assert.match(message, /edit\[0\]/);
    assert.match(message, /edit\[1\]/);
    assert.match(message, /edit\[2\]/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
