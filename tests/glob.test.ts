import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "../server/infra/tools";

// glob 工具测试:验证基本匹配、path 限定、detail 模式、limit 截断、IGNORED 跳过、
//              安全(敏感路径/越界)、无匹配、取消、只读语义。

function setupProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-"));
  mkdirSync(path.join(directory, "src", "components"), { recursive: true });
  mkdirSync(path.join(directory, "src", "sub"), { recursive: true });
  mkdirSync(path.join(directory, "dist"), { recursive: true });
  writeFileSync(path.join(directory, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(directory, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(directory, "src", "components", "Header.tsx"), "export const Header = () => null;\n");
  writeFileSync(path.join(directory, "src", "components", "Footer.tsx"), "export const Footer = () => null;\n");
  writeFileSync(path.join(directory, "src", "sub", "c.ts"), "export const c = 3;\n");
  writeFileSync(path.join(directory, "README.md"), "# Readme\n");
  writeFileSync(path.join(directory, ".env"), "SECRET=should-not-appear\n");
  writeFileSync(path.join(directory, "dist", "bundle.js"), "compiled\n");
  return directory;
}

test("glob: 基本匹配 **/*.ts", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "src/**/*.ts" }, name: "glob", projectRoot: directory });
    assert.equal(result.mutatedWorkspace, false);
    assert.match(result.output, /src[\\/]a\.ts/);
    assert.match(result.output, /src[\\/]b\.ts/);
    assert.match(result.output, /src[\\/]sub[\\/]c\.ts/);
    // 不应包含 .tsx、.md、.env、dist
    assert.ok(!result.output.includes(".tsx"));
    assert.ok(!result.output.includes("README.md"));
    assert.ok(!result.output.includes(".env"));
    assert.ok(!result.output.includes("dist"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 限定 path 子目录", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({
      args: { pattern: "**/*.tsx", path: "src/components" },
      name: "glob",
      projectRoot: directory
    });
    assert.match(result.output, /src\/components\/Header\.tsx/);
    assert.match(result.output, /src\/components\/Footer\.tsx/);
    // 返回值必须保持工作区相对路径，才能直接传给 read_file/edit_file。
    assert.ok(result.output.includes("src/components"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: detail=true 返回 size/mtime", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({
      args: { pattern: "src/a.ts", detail: true },
      name: "glob",
      projectRoot: directory
    });
    const parsed = JSON.parse(result.output.split("\n")[0]);
    assert.ok("path" in parsed);
    assert.ok("size" in parsed);
    assert.ok("mtime" in parsed);
    assert.equal(parsed.size, Buffer.byteLength("export const a = 1;\n"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: limit 截断", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-limit-"));
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(directory, `f${i}.ts`), `file ${i}\n`);
    }
    const result = await executeTool({ args: { pattern: "*.ts", limit: 2 }, name: "glob", projectRoot: directory });
    const lines = result.output.split("\n").filter((l) => l && !l.startsWith("("));
    assert.equal(lines.length, 2);
    assert.match(result.output, /已截断/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: IGNORED_DIRECTORIES 跳过 dist", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "**/*" }, name: "glob", projectRoot: directory });
    assert.ok(!result.output.includes("bundle.js"), "dist/ 应被跳过");
    assert.ok(!result.output.includes("dist"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 🔒 敏感路径排除", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "**/*" }, name: "glob", projectRoot: directory });
    assert.ok(!result.output.includes(".env"), ".env 不应出现在结果中");
    assert.ok(!result.output.includes("SECRET"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 🔒 路径越界拒绝", async () => {
  const directory = setupProject();
  try {
    await assert.rejects(
      executeTool({ args: { pattern: "**/*", path: "../" }, name: "glob", projectRoot: directory }),
      /路径必须位于项目根目录内/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 无匹配返回友好提示", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "*.nonexistent" }, name: "glob", projectRoot: directory });
    assert.equal(result.output, "未匹配到任何文件。");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 响应 AbortSignal", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-abort-"));
  try {
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(directory, `f${i}.ts`), `f${i}\n`);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeTool({
        args: { pattern: "**/*" },
        name: "glob",
        projectRoot: directory,
        signal: controller.signal
      } as never),
      /AbortError|运行已取消/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// === mtime 排序测试(对齐 Claude Code Glob 工具行为) ===

test("glob: 按 mtime 倒序排列(最近改过的文件在前)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-mtime-"));
  try {
    // 造 3 个文件,手动设置不同 mtime(单位:秒)
    // old.ts -> 1 小时前, mid.ts -> 1 分钟前, new.ts -> 现在
    const now = Date.now() / 1000;
    writeFileSync(path.join(directory, "old.ts"), "old\n");
    writeFileSync(path.join(directory, "mid.ts"), "mid\n");
    writeFileSync(path.join(directory, "new.ts"), "new\n");
    // Windows 文件系统 mtime 精度可能不够,显式设置确保可区分
    utimesSync(path.join(directory, "old.ts"), now - 3600, now - 3600);
    utimesSync(path.join(directory, "mid.ts"), now - 60, now - 60);
    utimesSync(path.join(directory, "new.ts"), now, now);

    const result = await executeTool({ args: { pattern: "*.ts" }, name: "glob", projectRoot: directory });
    const lines = result.output.split("\n").filter((l) => l && !l.startsWith("("));
    // 期望顺序: new → mid → old(最近改的在前)
    assert.equal(lines[0], "new.ts");
    assert.equal(lines[1], "mid.ts");
    assert.equal(lines[2], "old.ts");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: limit 在全量匹配后选出最近修改的文件", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-latest-limit-"));
  try {
    const now = Date.now() / 1000;
    writeFileSync(path.join(directory, "a-old.ts"), "old\n");
    writeFileSync(path.join(directory, "z-new.ts"), "new\n");
    utimesSync(path.join(directory, "a-old.ts"), now - 3_600, now - 3_600);
    utimesSync(path.join(directory, "z-new.ts"), now, now);

    const result = await executeTool({ args: { pattern: "*.ts", limit: 1 }, name: "glob", projectRoot: directory });
    const lines = result.output.split("\n").filter((line) => line && !line.startsWith("("));
    assert.deepEqual(lines, ["z-new.ts"]);
    assert.match(result.output, /已截断/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: 命中数刚好等于 limit 时不误报截断", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-exact-limit-"));
  try {
    writeFileSync(path.join(directory, "only.ts"), "only\n");
    const result = await executeTool({ args: { pattern: "*.ts", limit: 1 }, name: "glob", projectRoot: directory });
    assert.equal(result.output, "only.ts");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("glob: detail 模式也按 mtime 倒序", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-glob-detail-mtime-"));
  try {
    const now = Date.now() / 1000;
    writeFileSync(path.join(directory, "a.ts"), "a\n");
    writeFileSync(path.join(directory, "b.ts"), "b\n");
    utimesSync(path.join(directory, "a.ts"), now - 100, now - 100);
    utimesSync(path.join(directory, "b.ts"), now, now);

    const result = await executeTool({
      args: { pattern: "*.ts", detail: true },
      name: "glob",
      projectRoot: directory
    });
    const lines = result.output.split("\n").filter((l) => l && !l.startsWith("("));
    // b.ts 更近,应排第一
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.path, "b.ts");
    assert.equal(second.path, "a.ts");
    assert.ok(first.mtime > second.mtime, "b.ts 的 mtime 应大于 a.ts");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
