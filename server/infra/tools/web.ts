import { redactSensitiveText } from "./security";

// ─────────────────────────────────────────────────────────────────────────────
// Web 工具:fetch_url + web_search
//
// 设计要点:
//   - fetch_url:用 Node 内置 fetch 抓取 HTML,用轻量 regex 转 Markdown 风格文本。
//     不引入 turndown 等外部依赖,保持项目自包含。
//   - web_search:支持可配置的搜索后端(SEARCH_API_URL + SEARCH_API_KEY 环境变量),
//     无 key 时返回可操作的错误引导用户配置。
//   - 两者均走 redactSensitiveText 脱敏,防止抓取到的页面里含有敏感信息泄漏。
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_URL_TIMEOUT_MS = 30_000;
const FETCH_URL_MAX_BYTES = 1_000_000;

/**
 * 将 HTML 转为可读的 Markdown 风格纯文本。
 */
function htmlToReadableText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

export async function fetchUrl(
  input: { url: string; maxChars?: number; format?: "markdown" | "text" },
  signal?: AbortSignal
): Promise<string> {
  const url = String(input.url ?? "").trim();
  if (!url) throw new Error("url 不能为空。");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL:${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 http 和 https 协议(收到 ${parsed.protocol})。`);
  }
  const maxChars = Math.min(Math.max(1000, input.maxChars ?? 20_000), 200_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "DeepSeeker-CodeAgent/1.0", Accept: "text/html,application/json,text/plain,*/*" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`抓取失败:HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "";
    let raw = await response.text();
    if (raw.length > FETCH_URL_MAX_BYTES) raw = raw.slice(0, FETCH_URL_MAX_BYTES);
    const format = input.format ?? "markdown";
    let body: string;
    if (contentType.includes("application/json")) {
      body = raw;
    } else if (contentType.includes("text/plain")) {
      body = raw;
    } else {
      body = format === "text" ? htmlToReadableText(raw).replace(/[*#`>[\]()_-]/g, "") : htmlToReadableText(raw);
    }
    body = redactSensitiveText(body);
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n\n[已截断:原文 ${body.length} 字符,保留 ${maxChars} 字符]`;
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`抓取超时(${FETCH_URL_TIMEOUT_MS / 1000}s):${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(
  input: { query: string; limit?: number; allowedDomains?: string[]; blockedDomains?: string[] },
  signal?: AbortSignal
): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) throw new Error("query 不能为空。");
  const apiUrl = process.env.SEARCH_API_URL;
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("未配置搜索后端。请在环境变量中设置 SEARCH_API_URL 和 SEARCH_API_KEY(支持 Brave/Bing/SerpAPI 兼容端点)。");
  }
  const limit = Math.min(Math.max(1, input.limit ?? 5), 20);
  const allowedDomains = input.allowedDomains ?? [];
  const blockedDomains = input.blockedDomains ?? [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const separator = apiUrl.includes("?") ? "&" : "?";
    const searchUrl = `${apiUrl}${separator}q=${encodeURIComponent(query)}&count=${limit}`;
    const response = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`搜索 API 返回 HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    const rawResults: unknown[] =
      Array.isArray(data.results) ? data.results
      : Array.isArray((data.web as { results?: unknown[] })?.results) ? (data.web as { results: unknown[] }).results
      : Array.isArray(data.organic) ? data.organic
      : [];
    let results: SearchResult[] = rawResults
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).url === "string")
      .map((item) => ({
        snippet: String(item.snippet ?? item.description ?? ""),
        title: String(item.title ?? "Untitled"),
        url: String(item.url)
      }));
    if (allowedDomains.length > 0) {
      results = results.filter((item) => allowedDomains.some((domain) => domainMatches(item.url, domain)));
    }
    results = results.filter((item) => !blockedDomains.some((domain) => domainMatches(item.url, domain)));
    results = results.slice(0, limit);
    if (results.length === 0) return `未找到匹配 "${query}" 的结果。`;
    const lines = results.map((item, index) =>
      `${index + 1}. ${item.title}\n   ${item.url}\n   ${redactSensitiveText(item.snippet)}`
    );
    return lines.join("\n\n");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`搜索超时(${FETCH_URL_TIMEOUT_MS / 1000}s)`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function domainMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname;
    const cleanDomain = domain.replace(/^\*\./, "").toLowerCase();
    return host === cleanDomain || host.endsWith(`.${cleanDomain}`);
  } catch {
    return false;
  }
}

