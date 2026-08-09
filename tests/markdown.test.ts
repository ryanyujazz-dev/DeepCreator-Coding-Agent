import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decorateCitations, MarkdownContent } from "../src/components/MarkdownContent";

test("turns valid Responses citations into inline links and falls back to a source list", () => {
  const valid = decorateCitations("来源", [{ endIndex: 2, startIndex: 0, title: "官方文档", url: "https://example.com/docs" }]);
  assert.match(valid, /来源\[\[1\]\]/);
  assert.match(valid, /https:\/\/example\.com\/docs/);
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    citations: [{ endIndex: 2, startIndex: 0, title: "官方文档", url: "https://example.com/docs" }],
    text: "来源"
  }));
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /target="_blank"/);
  const fallback = decorateCitations("来源", [{ endIndex: 99, startIndex: 0, title: "官方文档", url: "https://example.com/docs" }]);
  assert.match(fallback, /来源：/);
  assert.equal(decorateCitations("来源", [{ endIndex: 2, startIndex: 0, title: "危险", url: "javascript:alert(1)" }]), "来源");
});

test("renders GFM structure and fenced code through the shared markdown surface", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: "## 结果\n\n- 第一项\n- 第二项\n\n| 文件 | 状态 |\n| --- | --- |\n| app.ts | 完成 |\n\n```ts\nconst ready = true;\n```"
  }));
  assert.match(html, /<h2>结果<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /markdown-table-scroll/);
  assert.match(html, /markdown-code-block/);
  assert.match(html, /markdown-code-language/);
  assert.match(html, />TypeScript</);
  assert.match(html, /markdown-code-line token-line/);
  assert.match(html, /aria-label="复制代码"/);
});

test("maps a streaming source range to its five-frame markdown fade class", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    fragments: [{ frame: 3, id: 1, text: "新增内容" }],
    stable: "已有内容 "
  }));
  assert.match(html, /streaming-fragment is-frame-3/);
  assert.match(html, />新增内容<\/span>/);
});

test("preserves streamed text nested inside a fenced code block", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    fragments: [{ frame: 2, id: 1, text: "ready = true;" }],
    stable: "```ts\nconst ",
    streaming: true,
    text: undefined
  }));
  const visibleText = html.replace(/<[^>]+>/g, "");
  assert.match(visibleText, /const ready = true;/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("escapes raw HTML from model markdown instead of creating executable nodes", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: "正常内容<script>alert('xss')</script>"
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&#x27;xss&#x27;\)&lt;\/script&gt;/);
});
