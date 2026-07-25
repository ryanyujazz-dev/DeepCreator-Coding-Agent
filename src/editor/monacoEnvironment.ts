import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import typescriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { ColorScheme, ThemeVariant } from "../../shared/contracts/theme";

type MonacoWorkerEnvironment = {
  getWorker: (moduleId: string, label: string) => Worker;
};

const workerScope = self as typeof self & { MonacoEnvironment?: MonacoWorkerEnvironment };

workerScope.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new typescriptWorker();
    return new editorWorker();
  }
};

loader.config({ monaco });

export function monacoThemeName(themeId: string, scheme: ColorScheme, variant: ThemeVariant): string {
  const signature = [
    variant.code.background,
    variant.code.foreground,
    variant.code.keyword,
    variant.code.string,
    variant.code.added,
    variant.code.removed
  ].join("").replaceAll("#", "").slice(0, 36);
  return `deepseeker-${themeId}-${scheme}-${signature}`;
}

export function prepareMonacoTheme(
  instance: typeof monaco,
  name: string,
  scheme: ColorScheme,
  variant: ThemeVariant
): void {
  const code = variant.code;
  const alpha = (color: string, opacity: string) => color.length === 7 ? `${color}${opacity}` : color;
  instance.editor.defineTheme(name, {
    base: scheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { foreground: code.comment.slice(1), token: "comment" },
      { foreground: code.comment.slice(1), token: "comment.doc" },
      { foreground: code.keyword.slice(1), token: "keyword" },
      { foreground: code.keyword.slice(1), token: "keyword.control" },
      { foreground: code.keyword.slice(1), token: "keyword.declaration" },
      { foreground: code.keyword.slice(1), token: "operator" },
      { foreground: code.string.slice(1), token: "string" },
      { foreground: code.string.slice(1), token: "string.escape" },
      { foreground: code.string.slice(1), token: "regexp" },
      { foreground: code.number.slice(1), token: "number" },
      { foreground: code.type.slice(1), token: "type.identifier" },
      { foreground: code.type.slice(1), token: "type" },
      { foreground: code.type.slice(1), token: "class" },
      { foreground: code.type.slice(1), token: "class.identifier" },
      { foreground: code.type.slice(1), token: "function" },
      { foreground: code.type.slice(1), token: "function.declaration" },
      { foreground: code.foreground.slice(1), token: "identifier" },
      { foreground: code.foreground.slice(1), token: "delimiter" }
    ],
    colors: {
      "editor.background": code.background,
      "editor.foreground": code.foreground,
      "editor.lineHighlightBackground": code.lineHighlight,
      "editor.selectionBackground": code.selection,
      "editor.inactiveSelectionBackground": code.selection,
      "editorLineNumber.foreground": code.lineNumber,
      "editorLineNumber.activeForeground": code.foreground,
      "editorGutter.background": code.background,
      "editorGutter.addedBackground": code.addedGutter,
      "editorGutter.deletedBackground": code.removedGutter,
      "editorGutter.modifiedBackground": variant.colors.warning,
      "editorIndentGuide.background1": variant.colors.border,
      "editorIndentGuide.activeBackground1": variant.colors.muted,
      "editorWidget.background": variant.colors.surfaceElevated,
      "editorWidget.border": variant.colors.border,
      "editorHoverWidget.background": variant.colors.surfaceElevated,
      "editorHoverWidget.border": variant.colors.border,
      "diffEditor.insertedLineBackground": code.added,
      "diffEditor.removedLineBackground": code.removed,
      "diffEditor.insertedTextBackground": code.added,
      "diffEditor.removedTextBackground": code.removed,
      "diffEditorGutter.insertedLineBackground": code.added,
      "diffEditorGutter.removedLineBackground": code.removed,
      "diffEditorOverview.insertedForeground": code.addedGutter,
      "diffEditorOverview.removedForeground": code.removedGutter,
      "diffEditor.unchangedRegionBackground": code.lineHighlight,
      "diffEditor.unchangedRegionForeground": code.lineNumber,
      "diffEditor.unchangedRegionShadow": "#00000000",
      "diffEditor.unchangedCodeBackground": code.lineHighlight,
      "diffEditor.diagonalFill": variant.colors.border,
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(variant.colors.muted, "33"),
      "scrollbarSlider.hoverBackground": alpha(variant.colors.muted, "55"),
      "scrollbarSlider.activeBackground": alpha(variant.colors.muted, "77")
    }
  });
}
