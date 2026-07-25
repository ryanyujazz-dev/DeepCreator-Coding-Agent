import { PatchDiff } from "@pierre/diffs/react";
import Editor, { useMonaco } from "@monaco-editor/react";
import { useEffect, useMemo } from "react";
import { DIFF_THEME_NAME, DIFF_UNSAFE_CSS, diffStyleVariables } from "../editor/diffEnvironment";
import { languageForPath } from "../editor/languages";
import { monacoThemeName, prepareMonacoTheme } from "../editor/monacoEnvironment";
import { modelsFromUnifiedPatch } from "../editor/unifiedPatch";
import { useTheme } from "../theme/ThemeProvider";

const sharedOptions = {
  automaticLayout: true,
  contextmenu: true,
  cursorBlinking: "solid" as const,
  folding: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontLigatures: false,
  fontSize: 12,
  glyphMargin: false,
  guides: { bracketPairs: true, indentation: true },
  lineDecorationsWidth: 9,
  lineHeight: 19,
  lineNumbersMinChars: 3,
  minimap: { enabled: false },
  overviewRulerBorder: false,
  padding: { bottom: 20, top: 8 },
  renderLineHighlight: "line" as const,
  renderWhitespace: "selection" as const,
  scrollbar: {
    horizontalScrollbarSize: 5,
    horizontalSliderSize: 5,
    useShadows: false,
    verticalScrollbarSize: 5,
    verticalSliderSize: 5
  },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  stickyScroll: { enabled: false },
  tabSize: 2,
  wordWrap: "off" as const
};

export function CodeFileViewer({ content, modelPath, path }: { content: string; modelPath: string; path: string }) {
  const { codeTheme, codeVariant, resolvedScheme } = useTheme();
  const monaco = useMonaco();
  const themeName = monacoThemeName(codeTheme.id, resolvedScheme, codeVariant);
  useEffect(() => {
    if (!monaco) return;
    prepareMonacoTheme(monaco, themeName, resolvedScheme, codeVariant);
    monaco.editor.setTheme(themeName);
  }, [codeVariant, monaco, resolvedScheme, themeName]);
  return (
    <div className="surface-editor-host">
      <Editor
        beforeMount={(instance) => prepareMonacoTheme(instance, themeName, resolvedScheme, codeVariant)}
        language={languageForPath(path)}
        options={{
          ...sharedOptions,
          domReadOnly: true,
          fontFamily: codeVariant.typography.codeFont,
          readOnly: true
        }}
        path={`file:///${modelPath.replace(/^\/+/, "")}`}
        saveViewState
        theme={themeName}
        value={content}
      />
    </div>
  );
}

export function CodeDiffViewer({ compact = false, patch, path }: { compact?: boolean; patch: string; path: string }) {
  const { codeVariant, resolvedScheme } = useTheme();
  const models = useMemo(() => modelsFromUnifiedPatch(patch), [patch]);
  const modelVersion = useMemo(
    () => Array.from(patch).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0).toString(36),
    [patch]
  );
  const compactHeight = Math.min(190, Math.max(76, models.sourceLineCount * sharedOptions.lineHeight + 16));
  return (
    <div
      className={`surface-diff-host ${compact ? "is-compact" : ""}`}
      style={compact ? { height: compactHeight } : undefined}
    >
      <PatchDiff
        className="surface-diff-view"
        disableWorkerPool
        key={`${path}:${modelVersion}`}
        options={{
          collapsedContextThreshold: 8,
          diffIndicators: "bars",
          diffStyle: "unified",
          disableFileHeader: true,
          expandUnchanged: false,
          hunkSeparators: "line-info",
          lineDiffType: "none",
          overflow: "scroll",
          theme: DIFF_THEME_NAME,
          themeType: resolvedScheme,
          unsafeCSS: DIFF_UNSAFE_CSS
        }}
        patch={patch}
        style={diffStyleVariables(codeVariant)}
      />
    </div>
  );
}
