import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/components/MarkdownContent";

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
