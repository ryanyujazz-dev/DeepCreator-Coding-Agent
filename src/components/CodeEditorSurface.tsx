import Editor, { OnMount } from "@monaco-editor/react";
import { editor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { languageForPath } from "../editor/languages";
import { MONACO_LIGHT_THEME, prepareMonaco } from "../editor/monacoEnvironment";

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

type DiffDisplayLine = {
  kind: "added" | "removed" | "unchanged";
  lineNumber: number | null;
  text: string;
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function displayLinesFromUnifiedPatch(patch: string): DiffDisplayLine[] {
  const lines: DiffDisplayLine[] = [];
  let originalLine = 1;
  let modifiedLine = 1;
  let insideHunk = false;

  for (const line of patch.split("\n")) {
    const hunk = line.match(hunkHeaderPattern);
    if (hunk) {
      insideHunk = true;
      originalLine = Number(hunk[1]);
      modifiedLine = Number(hunk[2]);
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("+")) {
      lines.push({ kind: "added", lineNumber: modifiedLine, text: line.slice(1) });
      modifiedLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({ kind: "removed", lineNumber: originalLine, text: line.slice(1) });
      originalLine += 1;
      continue;
    }
    const value = line.startsWith(" ") ? line.slice(1) : line;
    lines.push({ kind: "unchanged", lineNumber: modifiedLine, text: value });
    originalLine += 1;
    modifiedLine += 1;
  }

  return lines;
}

export function CodeFileViewer({ content, modelPath, path }: { content: string; modelPath: string; path: string }) {
  return (
    <div className="surface-editor-host">
      <Editor
        beforeMount={prepareMonaco}
        language={languageForPath(path)}
        options={{
          ...sharedOptions,
          domReadOnly: true,
          readOnly: true
        }}
        path={`file:///${modelPath.replace(/^\/+/, "")}`}
        saveViewState
        theme={MONACO_LIGHT_THEME}
        value={content}
      />
    </div>
  );
}

export function CodeDiffViewer({ compact = false, patch, path }: { compact?: boolean; patch: string; path: string }) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const displayLines = useMemo(() => displayLinesFromUnifiedPatch(patch), [patch]);
  const language = languageForPath(path);
  const modelVersion = useMemo(
    () => Array.from(patch).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0).toString(36),
    [patch]
  );
  const value = useMemo(() => displayLines.map((line) => line.text).join("\n"), [displayLines]);
  const compactHeight = Math.min(190, Math.max(76, displayLines.length * sharedOptions.lineHeight + 16));
  const updateDecorations = useCallback(() => {
    if (!editorRef.current) return;
    const decorations: editor.IModelDeltaDecoration[] = displayLines
      .map((line, index): editor.IModelDeltaDecoration | null => {
        if (line.kind === "unchanged") return null;
        const lineNumber = index + 1;
        return {
          range: {
            endColumn: 1,
            endLineNumber: lineNumber,
            startColumn: 1,
            startLineNumber: lineNumber
          },
          options: {
            className: line.kind === "added" ? "unified-diff-line-added" : "unified-diff-line-removed",
            isWholeLine: true,
            marginClassName: line.kind === "added" ? "unified-diff-margin-added" : "unified-diff-margin-removed"
          }
        };
      })
      .filter((item): item is editor.IModelDeltaDecoration => item !== null);
    if (!decorationsRef.current) {
      decorationsRef.current = editorRef.current.createDecorationsCollection(decorations);
      return;
    }
    decorationsRef.current.set(decorations);
  }, [displayLines]);
  const handleMount: OnMount = useCallback((instance) => {
    editorRef.current = instance;
    decorationsRef.current = null;
    updateDecorations();
  }, [updateDecorations]);
  useEffect(() => {
    updateDecorations();
  }, [updateDecorations, value]);
  return (
    <div
      className={`surface-editor-host is-diff ${compact ? "is-compact" : ""}`}
      style={compact ? { height: compactHeight } : undefined}
    >
      <Editor
        beforeMount={prepareMonaco}
        key={`${path}:${modelVersion}`}
        language={language}
        onMount={handleMount}
        options={{
          ...sharedOptions,
          domReadOnly: true,
          folding: compact ? false : sharedOptions.folding,
          lineNumbers: (lineNumber) => String(displayLines[lineNumber - 1]?.lineNumber ?? ""),
          padding: compact ? { bottom: 5, top: 5 } : sharedOptions.padding,
          readOnly: true,
          renderLineHighlight: "none"
        }}
        path={`inmemory://review/${modelVersion}/unified/${path}`}
        theme={MONACO_LIGHT_THEME}
        value={value}
      />
    </div>
  );
}
