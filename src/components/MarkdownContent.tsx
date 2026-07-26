import { Check, Code2, Copy } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import React, { lazy, ReactNode, Suspense, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StreamFragment } from "../stream/textFlow";
import { useOptionalTheme } from "../theme/ThemeProvider";

type FadeRange = {
  end: number;
  frame: number;
  start: number;
};

type HastNode = {
  children?: HastNode[];
  position?: { start?: { offset?: number } };
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
};

const MermaidBlock = lazy(() => import("./MermaidBlock").then((module) => ({ default: module.MermaidBlock })));

function fadePlugin(ranges: FadeRange[]) {
  return () => (tree: HastNode) => {
    const visit = (parent: HastNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "text" || !child.value || child.position?.start?.offset === undefined) {
          visit(child);
          return [child];
        }

        const nodeStart = child.position.start.offset;
        const nodeEnd = nodeStart + child.value.length;
        const overlaps = ranges.filter((range) => range.start < nodeEnd && range.end > nodeStart);
        if (overlaps.length === 0) return [child];

        const output: HastNode[] = [];
        let cursor = 0;
        for (const range of overlaps) {
          const start = Math.max(0, range.start - nodeStart);
          const end = Math.min(child.value.length, range.end - nodeStart);
          if (start > cursor) output.push({ type: "text", value: child.value.slice(cursor, start) });
          if (end > start) {
            output.push({
              children: [{ type: "text", value: child.value.slice(start, end) }],
              properties: {
                className: ["streaming-fragment", `is-frame-${range.frame}`]
              },
              tagName: "span",
              type: "element"
            });
          }
          cursor = Math.max(cursor, end);
        }
        if (cursor < child.value.length) output.push({ type: "text", value: child.value.slice(cursor) });
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

export function MarkdownContent({
  fragments = [],
  stable = "",
  streaming = false,
  text
}: {
  fragments?: StreamFragment[];
  stable?: string;
  streaming?: boolean;
  text?: string;
}) {
  const source = text ?? stable + fragments.map((fragment) => fragment.text).join("");
  const ranges = useMemo(() => {
    let cursor = stable.length;
    return fragments.map((fragment) => {
      const range = { end: cursor + fragment.text.length, frame: fragment.frame, start: cursor };
      cursor = range.end;
      return range;
    });
  }, [fragments, stable.length]);
  const streamPlugin = useMemo(() => fadePlugin(ranges), [ranges]);
  const components = useMemo(() => markdownComponents(streaming), [streaming]);

  return (
    <div className="markdown-content">
      <ReactMarkdown components={components} rehypePlugins={[streamPlugin]} remarkPlugins={[remarkGfm]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
