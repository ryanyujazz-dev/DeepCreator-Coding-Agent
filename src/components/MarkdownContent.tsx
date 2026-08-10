import { Check, Code2, Copy } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import React, { lazy, ReactNode, Suspense, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StreamFragment } from "../stream/textFlow";
import { useOptionalTheme } from "../theme/ThemeProvider";
import { ModelCitation } from "../../shared/contracts/provider";

type HastNode = {
  children?: HastNode[];
  position?: { start?: { offset?: number } };
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
};

const MermaidBlock = lazy(() => import("./MermaidBlock").then((module) => ({ default: module.MermaidBlock })));

// 把 source 中 [fadeStart, sourceEnd) 后缀(本次新到达、stable 前缀之后的部分)覆盖的文本节点
// 包成 <span className="markdown-streaming-fragment">,由 CSS animation 自动播一次淡入(83ms),
// 不再靠每帧 frame++ 改 className —— 故不依赖 React 重渲染,与上层 tree memo 配合根治收尾卡。
function fadePlugin(fadeStart: number, sourceEnd: number) {
  return () => (tree: HastNode) => {
    if (fadeStart >= sourceEnd) return;
    const visit = (parent: HastNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "text" || !child.value || child.position?.start?.offset === undefined) {
          visit(child);
          return [child];
        }
        const nodeStart = child.position.start.offset;
        const nodeEnd = nodeStart + child.value.length;
        if (nodeEnd <= fadeStart || nodeStart >= sourceEnd) return [child];
        const start = Math.max(0, fadeStart - nodeStart);
        const end = Math.min(child.value.length, sourceEnd - nodeStart);
        const output: HastNode[] = [];
        if (start > 0) output.push({ type: "text", value: child.value.slice(0, start) });
        if (end > start) {
          output.push({
            children: [{ type: "text", value: child.value.slice(start, end) }],
            properties: { className: ["markdown-streaming-fragment"] },
            tagName: "span",
            type: "element"
          });
        }
        if (end < child.value.length) output.push({ type: "text", value: child.value.slice(end) });
        return output;
      });
    };
    visit(tree);
  };
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (!isValidElement(node)) return "";
  return textFromNode((node.props as { children?: ReactNode }).children);
}

function CodeBlock({ children, followOutput }: { children: ReactNode; followOutput: boolean }) {
  // CodeBlock 只做语言分派,不调用任何 hook。这样语言切换(如 text -> mermaid)时
  // 不会触发 React "Rendered fewer hooks than expected" 错误。
  // 真正的实现(含 hook)拆到 MermaidBlock 和 PlainCodeBlock 两个子组件里。
  const properties = isValidElement(children)
    ? children.props as { children?: ReactNode; className?: string }
    : { children };
  const code = textFromNode(properties.children).replace(/\n$/, "");
  const language = properties.className?.match(/language-([^\s]+)/)?.[1] ?? "text";
  if (language === "mermaid") {
    return (
      <Suspense fallback={<pre className="markdown-code-block"><code>{code}</code></pre>}>
        <MermaidBlock code={code} followOutput={followOutput} />
      </Suspense>
    );
  }
  return <PlainCodeBlock code={code} followOutput={followOutput} language={language} />;
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  mermaid: "Mermaid",
  python: "Python",
  py: "Python",
  shell: "Shell",
  sh: "Shell",
  text: "代码",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML"
};

function PlainCodeBlock({ code, followOutput, language }: { code: string; followOutput: boolean; language: string }) {
  const prismTheme = useOptionalTheme()?.prismTheme ?? themes.github;
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const stickToEnd = useRef(true);
  useEffect(() => {
    const output = outputRef.current;
    if (!followOutput || !stickToEnd.current || !output) return;
    output.scrollTop = output.scrollHeight;
  }, [code, followOutput]);
  return (
    <section className="markdown-code-block">
      <header>
        <span className="markdown-code-language"><Code2 size={12} />{LANGUAGE_LABELS[language] ?? language}</span>
        <button
          aria-label="复制代码"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }).catch(() => undefined);
          }}
          title={copied ? "已复制" : "复制代码"}
          type="button"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </header>
      <Highlight code={code} language={language} theme={prismTheme}>
        {({ className, getLineProps, getTokenProps, style, tokens }) => (
          <pre
            className={className}
            onScroll={(event) => {
              const output = event.currentTarget;
              stickToEnd.current = output.scrollHeight - output.scrollTop - output.clientHeight < 28;
            }}
            ref={outputRef}
            style={{ ...style, background: "transparent" }}
          >
            <code>
              {tokens.map((line, lineIndex) => {
                const lineProps = getLineProps({ line });
                return (
                  <span
                    {...lineProps}
                    className={`markdown-code-line ${lineProps.className ?? ""}`.trim()}
                    key={lineIndex}
                  >
                    {line.map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                    {lineIndex < tokens.length - 1 ? "\n" : null}
                  </span>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </section>
  );
}

function markdownComponents(followOutput: boolean): Components {
  return {
    a: ({ children, href }) => <a href={href} rel="noreferrer" target="_blank">{children}</a>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    pre: ({ children }) => <CodeBlock followOutput={followOutput}>{children}</CodeBlock>,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>
  };
}

// components 必须引用稳定(模块级常量):streaming 翻转时若 components 变 → tree memo bust →
// 触发一次全文重解析(收尾 flip 帧)。followOutput 恒 true:PlainCodeBlock 的 scroll effect 仅在
// code 变化时触发,流式结束后 code 不变即与原行为等价,无副作用。
const STABLE_COMPONENTS = markdownComponents(true);

export function MarkdownContent({
  citations = [],
  fragments = [],
  stable = "",
  text
}: {
  citations?: ModelCitation[];
  fragments?: StreamFragment[];
  stable?: string;
  /** 保留以向后兼容(MessageActivity/测试仍传);components 已用模块级 STABLE_COMPONENTS,streaming 不再驱动渲染。解构不取 = 忽略。 */
  streaming?: boolean;
  text?: string;
}) {
  const rawSource = text ?? stable + fragments.map((fragment) => fragment.text).join("");
  const source = useMemo(() => decorateCitations(rawSource, citations), [citations, rawSource]);
  // fadeStart:仅随 source 变化时重算。text 直传(非流式全文已稳定)→ source.length(后缀空,不包 span);
  // 否则(流式 fragments/stable)→ stable.length(新字 = stable 前缀之后的部分)。
  // graduate(fragments 并入 stable)时 source 字符串值不变 → 此 memo 命中 → fadeStart 不变 →
  // streamPlugin 引用不变 → tree memo 命中 → 零重解析(根治收尾卡)。
  // 故意只列 source 依赖:text / stable.length 在 source 不变时若进 deps,graduate 会 bust memo → 修复静默失败。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fadeStart = useMemo(() => (text !== undefined ? source.length : stable.length), [source]);
  const streamPlugin = useMemo(() => fadePlugin(fadeStart, source.length), [fadeStart, source.length]);
  const tree = useMemo(() => (
    <ReactMarkdown components={STABLE_COMPONENTS} rehypePlugins={[streamPlugin]} remarkPlugins={[remarkGfm]}>
      {source}
    </ReactMarkdown>
  ), [source, streamPlugin]);
  return <div className="markdown-content">{tree}</div>;
}

function safeCitationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function decorateCitations(source: string, citations: ModelCitation[]): string {
  const safe = citations.filter((item) => safeCitationUrl(item.url));
  if (safe.length === 0) return source;
  const valid = safe.every((item) => Number.isInteger(item.startIndex)
    && Number.isInteger(item.endIndex)
    && item.startIndex >= 0
    && item.endIndex > item.startIndex
    && item.endIndex <= source.length);
  const marker = (item: ModelCitation, index: number) => {
    const title = item.title.replaceAll('"', "'").replaceAll("\n", " ");
    return `[[${index + 1}]](<${item.url}> "${title}")`;
  };
  if (!valid) {
    const sources = safe.map((item, index) => `- ${marker(item, index)} ${item.title}`).join("\n");
    return `${source}\n\n来源：\n${sources}`;
  }
  let result = source;
  const indexed = safe.map((item, index) => ({ index, item }))
    .sort((left, right) => right.item.endIndex - left.item.endIndex || right.index - left.index);
  for (const entry of indexed) {
    result = `${result.slice(0, entry.item.endIndex)}${marker(entry.item, entry.index)}${result.slice(entry.item.endIndex)}`;
  }
  return result;
}
