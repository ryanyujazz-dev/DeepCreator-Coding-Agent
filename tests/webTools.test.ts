import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import test from "node:test";
import { executeTool } from "../server/infra/tools";

// ─────────────────────────────────────────────────────────────────────────────
// web 工具测试:fetch_url + web_search。
//
// 策略:用本地 mock HTTP server 模拟外部 URL,不依赖真实网络。
// fetch_url 测试覆盖:HTML→Markdown 转换、maxChars 截断、协议校验、错误处理。
// web_search 测试覆盖:结果解析、域名过滤、无 key 报错、多种返回格式兼容。
// ─────────────────────────────────────────────────────────────────────────────

async function startMockServer(
  responder: (method: string, url: string, headers: Record<string, string | string[] | undefined>) => {
    status: number;
    body: string;
    contentType?: string;
  }
): Promise<{ port: number; close: () => void }> {
  const server = createServer((request, response) => {
    const { status, body, contentType } = responder(request.method ?? "", request.url ?? "", request.headers);
    response.writeHead(status, { "Content-Type": contentType ?? "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => server.close() };
}

// ─── fetch_url 测试 ──────────────────────────────────────────────────────────

test("fetch_url: converts HTML to readable markdown", async () => {
  const { port, close } = await startMockServer(() => ({
    body: "<html><body><h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>Item 1</li><li>Item 2</li></ul></body></html>",
    contentType: "text/html",
    status: 200
  }));
  try {
    const result = await executeTool({
      args: { url: `http://127.0.0.1:${port}/` },
      name: "fetch_url",
      projectRoot: "."
    });
    assert.match(result.output, /Title/);
    assert.match(result.output, /Hello world/);
    assert.match(result.output, /Item 1/);
    // script/style 标签应被移除
    assert.equal(result.output.includes("<html>"), false);
    assert.equal(result.output.includes("<strong>"), false);
  } finally {
    close();
  }
});

test("fetch_url: truncates to maxChars with a notice", async () => {
  const longText = "A".repeat(50_000);
  const { port, close } = await startMockServer(() => ({
    body: `<html><body><p>${longText}</p></body></html>`,
    contentType: "text/html",
    status: 200
  }));
  try {
    const result = await executeTool({
      args: { maxChars: 500, url: `http://127.0.0.1:${port}/` },
      name: "fetch_url",
      projectRoot: "."
    });
    assert.match(result.output, /已截断/);
    assert.ok(result.output.length < 50_000, "output should be truncated");
  } finally {
    close();
  }
});

test("fetch_url: rejects non-http protocols", async () => {
  await assert.rejects(
    executeTool({
      args: { url: "file:///etc/passwd" },
      name: "fetch_url",
      projectRoot: "."
    }),
    /http 和 https/
  );
});

test("fetch_url: rejects empty url", async () => {
  await assert.rejects(
    executeTool({
      args: { url: "" },
      name: "fetch_url",
      projectRoot: "."
    }),
    /不能为空/
  );
});

test("fetch_url: passes through JSON content", async () => {
  const { port, close } = await startMockServer(() => ({
    body: JSON.stringify({ key: "value", nested: { data: 42 } }),
    contentType: "application/json",
    status: 200
  }));
  try {
    const result = await executeTool({
      args: { url: `http://127.0.0.1:${port}/api` },
      name: "fetch_url",
      projectRoot: "."
    });
    assert.match(result.output, /"key"/);
    assert.match(result.output, /"value"/);
  } finally {
    close();
  }
});

test("fetch_url: throws on non-2xx response", async () => {
  const { port, close } = await startMockServer(() => ({
    body: "Not Found",
    contentType: "text/plain",
    status: 404
  }));
  try {
    await assert.rejects(
      executeTool({
        args: { url: `http://127.0.0.1:${port}/missing` },
        name: "fetch_url",
        projectRoot: "."
      }),
      /HTTP 404/
    );
  } finally {
    close();
  }
});

// ─── web_search 测试 ─────────────────────────────────────────────────────────

test("web_search: throws helpful error when backend not configured", async () => {
  // 确保环境变量未设置
  const savedUrl = process.env.SEARCH_API_URL;
  const savedKey = process.env.SEARCH_API_KEY;
  delete process.env.SEARCH_API_URL;
  delete process.env.SEARCH_API_KEY;
  try {
    await assert.rejects(
      executeTool({
        args: { query: "test" },
        name: "web_search",
        projectRoot: "."
      }),
      /未配置搜索后端/
    );
  } finally {
    if (savedUrl !== undefined) process.env.SEARCH_API_URL = savedUrl;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
  }
});

test("web_search: parses standard results format and applies domain filter", async () => {
  const { port, close } = await startMockServer(() => ({
    body: JSON.stringify({
      results: [
        { snippet: "Official docs", title: "Python Docs", url: "https://docs.python.org/3/tutorial/" },
        { snippet: "Community answers", title: "Stack Overflow", url: "https://stackoverflow.com/q/123" },
        { snippet: "Some blog", title: "Random Blog", url: "https://blog.example.com/post" }
      ]
    }),
    contentType: "application/json",
    status: 200
  }));
  const savedUrl = process.env.SEARCH_API_URL;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_URL = `http://127.0.0.1:${port}/search`;
  process.env.SEARCH_API_KEY = "test-search-key";
  try {
    const result = await executeTool({
      args: {
        query: "python tutorial",
        allowedDomains: ["docs.python.org", "stackoverflow.com"]
      },
      name: "web_search",
      projectRoot: "."
    });
    assert.match(result.output, /Python Docs/);
    assert.match(result.output, /Stack Overflow/);
    // blog.example.com 应被过滤掉
    assert.equal(result.output.includes("Random Blog"), false);
    assert.equal(result.output.includes("blog.example.com"), false);
  } finally {
    close();
    if (savedUrl !== undefined) process.env.SEARCH_API_URL = savedUrl;
    else delete process.env.SEARCH_API_URL;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

test("web_search: respects blockedDomains", async () => {
  const { port, close } = await startMockServer(() => ({
    body: JSON.stringify({
      results: [
        { snippet: "Good result", title: "Allowed", url: "https://good.example.com/" },
        { snippet: "Blocked result", title: "Blocked", url: "https://spam.example.com/" }
      ]
    }),
    contentType: "application/json",
    status: 200
  }));
  const savedUrl = process.env.SEARCH_API_URL;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_URL = `http://127.0.0.1:${port}/search`;
  process.env.SEARCH_API_KEY = "test-key";
  try {
    const result = await executeTool({
      args: {
        blockedDomains: ["spam.example.com"],
        query: "test"
      },
      name: "web_search",
      projectRoot: "."
    });
    assert.match(result.output, /Allowed/);
    assert.equal(result.output.includes("Blocked"), false);
    assert.equal(result.output.includes("spam.example.com"), false);
  } finally {
    close();
    if (savedUrl !== undefined) process.env.SEARCH_API_URL = savedUrl;
    else delete process.env.SEARCH_API_URL;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

test("web_search: handles Brave-style nested format { web: { results: [...] } }", async () => {
  const { port, close } = await startMockServer(() => ({
    body: JSON.stringify({
      web: {
        results: [
          { description: "Brave result", title: "Brave", url: "https://brave.example.com/" }
        ]
      }
    }),
    contentType: "application/json",
    status: 200
  }));
  const savedUrl = process.env.SEARCH_API_URL;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_URL = `http://127.0.0.1:${port}/search`;
  process.env.SEARCH_API_KEY = "test-key";
  try {
    const result = await executeTool({
      args: { query: "brave" },
      name: "web_search",
      projectRoot: "."
    });
    assert.match(result.output, /Brave/);
    assert.match(result.output, /Brave result/);
  } finally {
    close();
    if (savedUrl !== undefined) process.env.SEARCH_API_URL = savedUrl;
    else delete process.env.SEARCH_API_URL;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

test("web_search: returns no-results message for empty matches", async () => {
  const { port, close } = await startMockServer(() => ({
    body: JSON.stringify({ results: [] }),
    contentType: "application/json",
    status: 200
  }));
  const savedUrl = process.env.SEARCH_API_URL;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_URL = `http://127.0.0.1:${port}/search`;
  process.env.SEARCH_API_KEY = "test-key";
  try {
    const result = await executeTool({
      args: { query: "nonexistent" },
      name: "web_search",
      projectRoot: "."
    });
    assert.match(result.output, /未找到匹配/);
  } finally {
    close();
    if (savedUrl !== undefined) process.env.SEARCH_API_URL = savedUrl;
    else delete process.env.SEARCH_API_URL;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});
