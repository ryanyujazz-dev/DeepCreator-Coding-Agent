import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "../server/infra/tools";

// list_files 工具测试:depth 分层(默认 1 / 显式 2 / -1 全量)、目录以 / 后缀出现、
//                      maxFiles 截断标注、敏感文件与忽略目录跳过。

function setupProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-listfiles-"));
  mkdirSync(path.join(directory, "src", "components"), { recursive: true });
  mkdirSync(path.join(directory, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(directory, "README.md"), "# Readme\n");
  writeFileSync(path.join(directory, ".env.example"), "KEY=replace-me\n");
  writeFileSync(path.join(directory, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(directory, "src", "components", "Header.tsx"), "export const Header = () => null;\n");
  writeFileSync(path.join(directory, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  return directory;
}

test("list_files: 默认 depth=1 只列顶层,目录以 / 后缀出现", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: {}, name: "list_files", projectRoot: directory });
    assert.ok(result.output.includes("README.md"));
    assert.ok(result.output.includes(".env.example"));
    assert.ok(result.output.includes("src/"));
    // 顶层之外的条目不应出现
    assert.ok(!result.output.includes("a.ts"));
    assert.ok(!result.output.includes("Header.tsx"));
    // 忽略目录不出现
    assert.ok(!result.output.includes("node_modules"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("list_files: depth=2 展开到二层", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { depth: 2 }, name: "list_files", projectRoot: directory });
    assert.ok(result.output.includes("src/a.ts"));
    assert.ok(result.output.includes("src/components/"));
    // 三层文件不应出现(components 内部未展开)
    assert.ok(!result.output.includes("Header.tsx"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("list_files: depth=-1 全量递归(旧行为)", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { depth: -1 }, name: "list_files", projectRoot: directory });
    assert.ok(result.output.includes("src/a.ts"));
    assert.ok(result.output.includes("src/components/Header.tsx"));
    // 全量递归下目录本身不再单独列出(只列文件)
    assert.ok(!/\bsrc\/\n/.test(result.output));
    // 忽略目录内的文件不出现
    assert.ok(!result.output.includes("node_modules"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("list_files: 超过 maxFiles 时尾附截断标注", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { depth: -1, maxFiles: 2 }, name: "list_files", projectRoot: directory });
    assert.ok(result.output.includes("…[已达 maxFiles=2 上限，结果已截断；可用 depth 或 glob 收窄]"));
    const lines = result.output.split("\n").filter((line) => line && !line.startsWith("…["));
    assert.ok(lines.length <= 2);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("list_files: 敏感文件在任意 depth 下都不出现", async () => {
  const directory = setupProject();
  try {
    writeFileSync(path.join(directory, ".env.local"), "KEY=secret\n");
    const result = await executeTool({ args: { depth: -1 }, name: "list_files", projectRoot: directory });
    assert.ok(!result.output.includes(".env.local"));
    assert.ok(result.output.includes(".env.example"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
