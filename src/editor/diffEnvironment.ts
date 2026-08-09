import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { CSSProperties } from "react";
import { ThemeVariant } from "../../shared/contracts/theme";

export const DIFF_THEME_NAME = "deepcreator-css-variables";

registerCustomCSSVariableTheme(DIFF_THEME_NAME, {
  background: "var(--app-canvas)",
  foreground: "#24292f",
  "token-changed": "#9a6700",
  "token-comment": "#6e7781",
  "token-constant": "#0550ae",
  "token-deleted": "#cf222e",
  "token-function": "#8250df",
  "token-inserted": "#1f883d",
  "token-keyword": "#cf222e",
  "token-link": "#0550ae",
  "token-parameter": "#24292f",
  "token-punctuation": "#24292f",
  "token-string": "#0a3069",
  "token-string-expression": "#0a3069"
});

// 这些键必须用 `--diffs-` 前缀,不是 `--diffs-global-`。registerCustomCSSVariableTheme 内部调用
// formatCSSVariablePrefix("global"),其返回 `--diffs-`(只有传 "token" 才返回 `--diffs-token-`),
// 故 Shiki 主题消费的是 `--diffs-foreground`/`--diffs-background`/`--diffs-token-<type>`。写成
// `--diffs-global-*` 等于设了永远不被读取的变量 → 落到注册时的 GitHub-light 字面量兜底(如
// foreground #24292f),暗黑模式下就是深色字深色底、文字不可见。这些内联样式经 React 以
// setProperty 设到 CodeView 宿主 div 上,自定义属性可穿透 shadow DOM 被 <diffs-container> 继承。
export function diffStyleVariables(variant: ThemeVariant): CSSProperties {
  const { code, colors, typography } = variant;
  return {
    "--diffs-addition-color-override": code.addedGutter,
    "--diffs-bg-addition-emphasis-override": "transparent",
    "--diffs-bg-addition-number-override": code.added,
    "--diffs-bg-addition-override": code.addedGutter,
    "--diffs-bg-context-gutter-override": "var(--app-canvas)",
    "--diffs-bg-context-override": "var(--app-canvas)",
    "--diffs-bg-deletion-emphasis-override": "transparent",
    "--diffs-bg-deletion-number-override": code.removed,
    "--diffs-bg-deletion-override": code.removedGutter,
    "--diffs-bg-separator-override": code.lineHighlight,
    "--diffs-deletion-color-override": code.removedGutter,
    "--diffs-font-family": typography.codeFont,
    "--diffs-font-size": "12px",
    "--diffs-fg-number-override": code.lineNumber,
    "--diffs-gap-block": "0px",
    "--diffs-gap-inline": "0px",
    "--diffs-background": "var(--app-canvas)",
    "--diffs-foreground": code.foreground,
    "--diffs-token-changed": colors.warning,
    "--diffs-token-comment": code.comment,
    "--diffs-token-constant": code.number,
    "--diffs-token-deleted": code.removedGutter,
    "--diffs-token-function": code.type,
    "--diffs-token-inserted": code.addedGutter,
    "--diffs-token-keyword": code.keyword,
    "--diffs-token-link": colors.accent,
    "--diffs-token-parameter": code.foreground,
    "--diffs-token-punctuation": code.foreground,
    "--diffs-token-string": code.string,
    "--diffs-token-string-expression": code.string,
    "--diffs-line-height": "19px",
    "--diffs-light": code.foreground,
    "--diffs-light-bg": "var(--app-canvas)",
    "--diffs-dark": code.foreground,
    "--diffs-dark-bg": "var(--app-canvas)",
    "--diffs-scrollbar-gutter-override": "5px"
  } as CSSProperties;
}

export const DIFF_UNSAFE_CSS = `
  :host {
    min-width: 0;
    background: var(--diffs-bg);
  }

  [data-diff] {
    border: 0;
  }

  [data-line],
  [data-column-number],
  [data-no-newline] {
    padding-inline: 8px;
  }

  [data-column-number] {
    padding-left: 11px;
    padding-right: 8px;
  }

  [data-indicators="bars"] [data-line-type="change-deletion"][data-column-number]::before,
  [data-indicators="bars"] [data-line-type="change-addition"][data-column-number]::before {
    width: 3px;
  }

  [data-diff-span] {
    border-radius: 0;
    background-color: transparent;
  }

  [data-separator] [data-separator-wrapper] {
    border-radius: 7px;
  }
`;
