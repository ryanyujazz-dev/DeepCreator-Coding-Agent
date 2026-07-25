import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { CSSProperties } from "react";
import { ThemeVariant } from "../../shared/contracts/theme";

export const DIFF_THEME_NAME = "deepseeker-css-variables";

registerCustomCSSVariableTheme(DIFF_THEME_NAME, {
  background: "#ffffff",
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

export function diffStyleVariables(variant: ThemeVariant): CSSProperties {
  const { code, colors, typography } = variant;
  return {
    "--diffs-addition-color-override": code.addedGutter,
    "--diffs-bg-addition-emphasis-override": "transparent",
    "--diffs-bg-addition-number-override": code.added,
    "--diffs-bg-addition-override": code.addedGutter,
    "--diffs-bg-context-gutter-override": code.background,
    "--diffs-bg-context-override": code.background,
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
    "--diffs-global-background": code.background,
    "--diffs-global-foreground": code.foreground,
    "--diffs-global-token-changed": colors.warning,
    "--diffs-global-token-comment": code.comment,
    "--diffs-global-token-constant": code.number,
    "--diffs-global-token-deleted": code.removedGutter,
    "--diffs-global-token-function": code.type,
    "--diffs-global-token-inserted": code.addedGutter,
    "--diffs-global-token-keyword": code.keyword,
    "--diffs-global-token-link": colors.accent,
    "--diffs-global-token-parameter": code.foreground,
    "--diffs-global-token-punctuation": code.foreground,
    "--diffs-global-token-string": code.string,
    "--diffs-global-token-string-expression": code.string,
    "--diffs-line-height": "19px",
    "--diffs-light": code.foreground,
    "--diffs-light-bg": code.background,
    "--diffs-dark": code.foreground,
    "--diffs-dark-bg": code.background,
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
