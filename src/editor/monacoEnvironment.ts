import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import typescriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export const MONACO_LIGHT_THEME = "deepseeker-light";

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

let themeRegistered = false;

export function prepareMonaco(instance: typeof monaco): void {
  if (themeRegistered) return;
  instance.editor.defineTheme(MONACO_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { foreground: "6A737D", token: "comment" },
      { foreground: "D73A49", token: "keyword" },
      { foreground: "032F62", token: "string" },
      { foreground: "005CC5", token: "number" },
      { foreground: "6F42C1", token: "type.identifier" },
      { foreground: "6F42C1", token: "type" }
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#1f2328",
      "editor.lineHighlightBackground": "#F6F8FA",
      "editor.selectionBackground": "#ADD6FF80",
      "editor.inactiveSelectionBackground": "#E5EBF1",
      "editorLineNumber.foreground": "#7d8590",
      "editorLineNumber.activeForeground": "#57606a",
      "editorGutter.background": "#FFFFFF",
      "editorGutter.addedBackground": "#1f883d",
      "editorGutter.deletedBackground": "#cf222e",
      "editorGutter.modifiedBackground": "#9a6700",
      "editorIndentGuide.background1": "#EEF0F1",
      "editorIndentGuide.activeBackground1": "#CDD2D5",
      "editorWidget.background": "#FFFFFF",
      "editorWidget.border": "#DDE1E3",
      "editorHoverWidget.background": "#FFFFFF",
      "editorHoverWidget.border": "#DDE1E3",
      "diffEditor.insertedLineBackground": "#dafbe180",
      "diffEditor.removedLineBackground": "#ffebe980",
      "diffEditor.insertedTextBackground": "#aceebb7a",
      "diffEditor.removedTextBackground": "#ffcecb7a",
      "diffEditorGutter.insertedLineBackground": "#dafbe180",
      "diffEditorGutter.removedLineBackground": "#ffebe980",
      "diffEditorOverview.insertedForeground": "#1f883d99",
      "diffEditorOverview.removedForeground": "#cf222e99",
      "diffEditor.unchangedRegionBackground": "#f6f8fa",
      "diffEditor.unchangedRegionForeground": "#6e7781",
      "diffEditor.unchangedCodeBackground": "#f6f8fa",
      "diffEditor.diagonalFill": "#d0d7de66",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#8C959F33",
      "scrollbarSlider.hoverBackground": "#8C959F55",
      "scrollbarSlider.activeBackground": "#6E778166"
    }
  });
  themeRegistered = true;
}
