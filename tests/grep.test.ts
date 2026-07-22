import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "../server/infra/tools";

// grep 工具测试:复用 securityAndApproval.test.ts 的 mkdtempSync + try/finally rmSync 模式。
// 重点验证:基本搜索、正则、大小写、glob 过滤、JSON 模式、截断、IGNORED 跳过、
//          安全(敏感路径/脱敏/越界)、取消、无命中、无效正则、只读语义。

function setupProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-"));
  mkdirSync(path.join(directory, "src", "sub"), { recursive: true });
  mkdirSync(path.join(directory, "node_modules", "lib"), { recursive: true });
  writeFileSync(path.join(directory, "src", "a.ts"), "TODO: fix this\nfunction foo() { return 1; }\n// todo: lowercase\n");
  writeFileSync(path.join(directory, "src", "sub", "b.ts"), "export const x = 1; // TODO: export more\nfunction bar() {}\n");
  writeFileSync(path.join(directory, "src", "notes.md"), "# Notes\nSome TODO here\n");
  writeFileSync(path.join(directory, ".env"), "API_KEY=sk-abcdefghij1234\nTODO: should not be searched\n");
  writeFileSync(path.join(directory, "node_modules", "lib", "hidden.js"), "TODO: this should be skipped\n");
  return directory;
}

test("grep: 基本搜索命中 files_with_matches 默认格式", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "TODO" }, name: "grep", projectRoot: directory });
    assert.equal(result.mutatedWorkspace, false);
    // 默认 files_with_matches:应返回 3 个文件路径(src/a.ts、src/sub/b.ts、src/notes.md)
    assert.match(result.output, /src[\\/]a\.ts/);
    assert.match(result.output, /src[\\/]sub[\\/]b\.ts/);
    assert.match(result.output, /src[\\/]notes\.md/);
    assert.ok(!result.output.includes("should not be searched"), "敏感文件 .env 不应被搜索");
    assert.ok(!result.output.includes("this should be skipped"), "node_modules 不应被搜索");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 正则表达式支持", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "function\\s+\\w+", output_mode: "content" }, name: "grep", projectRoot: directory });
    assert.match(result.output, /function foo/);
    assert.match(result.output, /function bar/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: case_sensitive=false 默认大小写不敏感", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "todo", output_mode: "content" }, name: "grep", projectRoot: directory });
    // 应同时命中 TODO(大写)和 todo(小写,src/a.ts 行3 的 "// todo: lowercase")
    assert.match(result.output, /TODO: fix this/);
    assert.match(result.output, /\/\/ todo: lowercase/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: case_sensitive=true 严格大小写", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "TODO", case_sensitive: true, output_mode: "content" }, name: "grep", projectRoot: directory });
    assert.ok(!result.output.includes("lowercase"), "case_sensitive=true 不应匹配小写 todo");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: glob 过滤文件类型", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({
      args: { pattern: "TODO", glob: "**/*.ts", output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /src[\\/]a\.ts/);
    assert.match(result.output, /src[\\/]sub[\\/]b\.ts/);
    assert.ok(!result.output.includes("notes.md"), "notes.md 应被 glob 过滤掉");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: output_mode=json 返回结构化字段", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({
      args: { pattern: "function\\s+\\w+", output_mode: "json" },
      name: "grep",
      projectRoot: directory
    });
    const hits = JSON.parse(result.output);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 2);
    const first = hits[0];
    assert.ok("path" in first && "line" in first && "column" in first && "match" in first);
    assert.ok("contextBefore" in first && "contextAfter" in first);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: max_results 截断(content 模式按命中行数截断)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-trunc-"));
  try {
    // 造 5 个文件,每个 1 个命中
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(directory, `f${i}.ts`), `TODO: number ${i}\n`);
    }
    const result = await executeTool({ args: { pattern: "TODO", max_results: 2, output_mode: "content" }, name: "grep", projectRoot: directory });
    assert.match(result.output, /已截断/);
    assert.match(result.output, /仅显示前 2 条/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 🔒 敏感文件搜索前过滤(.env 不被命中)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-secret-"));
  try {
    writeFileSync(path.join(directory, ".env"), "API_KEY=leaked-secret-value-here\nTODO: rotate key\n");
    writeFileSync(path.join(directory, "app.ts"), "TODO: normal\n");
    const result = await executeTool({ args: { pattern: "TODO", output_mode: "content" }, name: "grep", projectRoot: directory });
    assert.ok(!result.output.includes("leaked-secret"), ".env 内容不应进结果");
    assert.ok(!result.output.includes("rotate key"));
    assert.match(result.output, /app\.ts:1:TODO: normal/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 🔒 输出整体脱敏(sk- 格式 API key)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-redact-"));
  try {
    // app.ts 里出现 sk- 格式 key(非敏感文件名,但内容含密钥),输出应脱敏
    writeFileSync(path.join(directory, "app.ts"), 'const key = "sk-abcdefghij1234";\n');
    const result = await executeTool({ args: { pattern: "sk-", output_mode: "content" }, name: "grep", projectRoot: directory });
    assert.ok(result.output.includes("[REDACTED_API_KEY]"), "sk- 格式 key 应被脱敏");
    assert.ok(!result.output.includes("sk-abcdefghij1234"), "原始 key 不应泄露");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 🔒 路径越界拒绝", async () => {
  const directory = setupProject();
  try {
    await assert.rejects(
      executeTool({ args: { pattern: "x", path: "../" }, name: "grep", projectRoot: directory }),
      /路径必须位于项目根目录内/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 无命中返回友好提示", async () => {
  const directory = setupProject();
  try {
    const result = await executeTool({ args: { pattern: "ZZZ_NOT_EXIST_12345" }, name: "grep", projectRoot: directory });
    assert.equal(result.output, "未找到匹配内容。");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 无效正则抛错", async () => {
  const directory = setupProject();
  try {
    await assert.rejects(
      executeTool({ args: { pattern: "[" }, name: "grep", projectRoot: directory }),
      /无效的正则表达式/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 响应 AbortSignal", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-abort-"));
  try {
    // 造多个文件,确保 walk 还没结束就被取消
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(directory, `f${i}.ts`), `TODO: ${i}\n`);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeTool({
        args: { pattern: "TODO" },
        name: "grep",
        projectRoot: directory,
        signal: controller.signal
      } as never),
      /AbortError|运行已取消/
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// === 方言归一化测试:JS RegExp 不支持 PCRE 的 (?i) 等内联标志,需自动归一化 ===

test("grep: 方言归一化 (?i) 内联标志转为外部大小写不敏感", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-dialect-i-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "TODO: upper\nTodo: mixed\ntodo: lower\n");
    // (?i)todo|TODO 这种 PCRE 写法在 JS 会抛 Invalid group,但应被归一化
    const result = await executeTool({
      args: { pattern: "(?i)todo", output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /TODO: upper/);
    assert.match(result.output, /Todo: mixed/);
    assert.match(result.output, /todo: lower/);
    assert.match(result.output, /已把内联 \(\?i\) 标志转换为外部大小写不敏感/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 方言归一化 (?i:foo) 内联标志组保留组体", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-dialect-group-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "Foo bar\nfoo baz\nFOO qux\n");
    // (?i:foo) 应被转成非捕获组 + 外部 i 标志
    const result = await executeTool({
      args: { pattern: "(?i:foo)\\s+bar", output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /Foo bar/);
    assert.ok(!result.output.includes("foo baz"), "只匹配 foo+bar 组合");
    assert.ok(!result.output.includes("FOO qux"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: 方言归一化 (?-i) 取反标志剥离并警告", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-dialect-neg-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "abcDEF\n");
    // (?-i) 取反标志 JS 不支持,应被剥离并记录警告。剩余 abc 仍按外部 i 标志匹配
    const result = await executeTool({
      args: { pattern: "(?-i)abc", output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /abcDEF/);
    assert.match(result.output, /已剥离 JS 不支持的取反内联标志/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: case_sensitive=true 与 (?i) 同时出现时以参数为准", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-dialect-conflict-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "TODO upper\ntodo lower\n");
    // 用户显式 case_sensitive=true,即便 pattern 带 (?i),也应严格大小写
    const result = await executeTool({
      args: { pattern: "(?i)TODO", case_sensitive: true, output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /TODO upper/);
    // case_sensitive=true 时 (?i) 被剥离但外部不加 i,所以小写 todo 不应命中
    assert.ok(!result.output.includes("todo lower"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// === fixed_strings 模式测试 ===

test("grep: fixed_strings=true 把 pattern 当字面量(转义元字符)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-fixed-"));
  try {
    // 文件里包含字面的 "function.*test" 字符串(不是正则)
    writeFileSync(path.join(directory, "a.ts"), 'const desc = "function.*test";\nfunction test() {}\n');
    const result = await executeTool({
      args: { pattern: "function.*test", fixed_strings: true, output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    // 字面量模式:只命中 "function.*test" 这个字符串,不命中 "function test"
    assert.match(result.output, /function\.\*test/);
    assert.ok(!result.output.includes("function test()"), "字面量模式不应把 .* 当通配符");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: fixed_strings=true 搜索包含正则元字符的字符串(如 API key)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-fixed-key-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), 'const url = "https://api.example.com/v1/users";\n');
    // 搜一个含 / 和 . 的 URL,字面量模式必须正常工作
    const result = await executeTool({
      args: { pattern: "https://api.example.com/v1/users", fixed_strings: true, output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.ok(result.output.includes("api.example.com"));
    assert.ok(!result.output.includes("未找到匹配"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// === 错误信息测试 ===

test("grep: 真正无效的正则给出可操作的错误提示", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-badregex-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "content\n");
    // [ 单独一个方括号是真正无效的正则,无法通过归一化救回
    await assert.rejects(
      executeTool({ args: { pattern: "[" }, name: "grep", projectRoot: directory }),
      (error: Error) => {
        assert.match(error.message, /无效的正则表达式/);
        assert.match(error.message, /case_sensitive=false|fixed_strings/);
        return true;
      }
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// === output_mode 三档测试(Claude Code 兼容设计) ===

test("grep: output_mode=files_with_matches 默认只返回文件路径", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-fm-"));
  try {
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(path.join(directory, "src", "a.ts"), "TODO: one\nTODO: two\n");
    writeFileSync(path.join(directory, "src", "b.ts"), "TODO: three\n");
    writeFileSync(path.join(directory, "c.md"), "no match here\n");
    // 不传 output_mode 时默认 files_with_matches
    const result = await executeTool({ args: { pattern: "TODO" }, name: "grep", projectRoot: directory });
    const lines = result.output.split("\n").filter((l) => l && !l.startsWith("("));
    // 应该只返回 2 个文件路径,不包含行内容
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.includes("a.ts")));
    assert.ok(lines.some((l) => l.includes("b.ts")));
    assert.ok(!lines.includes("c.md"), "无命中的文件不应出现");
    // 关键:不应包含行内容(不是 path:line:content 格式)
    assert.ok(!result.output.includes("TODO: one"), "files_with_matches 不应返回行内容");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: output_mode=files_with_matches 显式传参同样生效", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-fm-explicit-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "TODO: x\n");
    const result = await executeTool({
      args: { pattern: "TODO", output_mode: "files_with_matches" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /a\.ts/);
    assert.ok(!result.output.includes("TODO: x"), "显式 files_with_matches 也不返回行内容");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: output_mode=count 返回每文件命中数", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-count-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "TODO: one\nTODO: two\nTODO: three\n");
    writeFileSync(path.join(directory, "b.ts"), "TODO: only one\n");
    const result = await executeTool({
      args: { pattern: "TODO", output_mode: "count" },
      name: "grep",
      projectRoot: directory
    });
    // 格式: path:count
    assert.match(result.output, /a\.ts:3/);
    assert.match(result.output, /b\.ts:1/);
    // 不应包含行内容
    assert.ok(!result.output.includes("TODO: one"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("grep: output_mode=content 仍返回 path:line:content(向后兼容)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-grep-content-"));
  try {
    writeFileSync(path.join(directory, "a.ts"), "TODO: fix this\n");
    const result = await executeTool({
      args: { pattern: "TODO", output_mode: "content" },
      name: "grep",
      projectRoot: directory
    });
    assert.match(result.output, /a\.ts:1:TODO: fix this/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
