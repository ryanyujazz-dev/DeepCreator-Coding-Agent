import { parsePatchFiles } from "@pierre/diffs";
import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";
import { CodeView, PatchDiff } from "@pierre/diffs/react";
import { ChevronRight } from "lucide-react";
import Editor, { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  overviewRulerLanes: 0,
  padding: { bottom: 20, top: 8 },
  renderLineHighlight: "none" as const,
  renderWhitespace: "selection" as const,
  scrollbar: {
    horizontal: "hidden" as const,
    useShadows: false,
    vertical: "hidden" as const
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

// 审阅面板用:PatchDiff 的 patch 只接受单文件,多文件要用库原生的 CodeView。
// 做法:把所有文件的 patch 拼成一段 → parsePatchFiles 解析成 FileDiffMetadata[] → 作为 items 喂给 CodeView。
// CodeView 自带单一滚动视口 + 跨文件虚拟化 + stickyHeaders(文件名吸顶),实现「文件名—内容区」纵向堆叠 + 统一滚动。
//
// 折叠:CodeView 逐项支持 collapsed(VirtualizedFileDiff 在 collapsed 时只留 header、不渲染代码体)。但 CodeView
// 没有 onHeaderClick,且 controlled 模式下命令式 updateItem 会抛错——所以改用 renderCustomHeader 渲染可点击的
// 自定义文件头(渲染进 [data-diffs-header="custom"] 的 header-custom slot,light DOM,文档样式可命中;提供
// custom header 时库不再渲染默认 title/计数,无重复;stickyHeaders 仍会给该 wrapper 加 data-sticky → 吸顶)。
// 点击即翻转 controlled items 里对应项的 collapsed。注意 CodeView 的 syncItemRecord 仅在 item.version 变化时才
// 采纳新快照:version 不变就忽略更新,故每项 version 必须随 collapsed 与 patch 内容一起变化(patchVersion + collapsed)。
// fileDiffs 单独 memo 在 [patch] 上:折叠翻转时 fileDiff 引用不变 → areDiffTargetsEqual 成立 → 不触发重新分词。
export function CodeReviewDiffViewer({ patch }: { patch: string }) {
  const { codeVariant, resolvedScheme } = useTheme();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const fileDiffs = useMemo<FileDiffMetadata[]>(() => {
    if (!patch) return [];
    try {
      return parsePatchFiles(patch).flatMap((entry) => entry.files);
    } catch {
      return [];
    }
  }, [patch]);
  const patchVersion = useMemo(
    () => Array.from(patch).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0),
    [patch]
  );
  const items = useMemo<CodeViewItem[]>(() => {
    const seen = new Set<string>();
    return fileDiffs.map((fileDiff, index) => {
      let id = fileDiff.name || `file-${index}`;
      while (seen.has(id)) id = `${fileDiff.name || "file"}-${index}`;
      seen.add(id);
      const collapsed = collapsedIds.has(id);
      return { collapsed, fileDiff, id, type: "diff" as const, version: patchVersion + (collapsed ? 1 : 0) };
    });
  }, [collapsedIds, fileDiffs, patchVersion]);
  const renderHeader = useCallback((item: CodeViewItem) => {
    if (item.type !== "diff") return null;
    const fileDiff = item.fileDiff;
    const collapsed = item.collapsed === true;
    const slash = fileDiff.name.lastIndexOf("/");
    const fileName = slash >= 0 ? fileDiff.name.slice(slash + 1) : fileDiff.name;
    const directory = slash >= 0 ? fileDiff.name.slice(0, slash) : "";
    let additions = 0;
    let deletions = 0;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionCount;
      deletions += hunk.deletionCount;
    }
    return (
      <button
        aria-expanded={!collapsed}
        className={`surface-review-fileheader${collapsed ? " is-collapsed" : ""}`}
        onClick={() => toggleCollapsed(item.id)}
        title={fileDiff.name}
        type="button"
      >
        <ChevronRight className="surface-review-chevron" size={14} />
        <span className="surface-review-filename">{fileName}</span>
        {directory && <span className="surface-review-filepath">{directory}</span>}
        <span className="surface-review-adds">+{additions}</span>
        <span className="surface-review-dels">−{deletions}</span>
      </button>
    );
  }, [toggleCollapsed]);
  return (
    <div className="surface-review-stream">
      <CodeView
        className="surface-review-codeview"
        disableWorkerPool
        items={items}
        options={{
          collapsedContextThreshold: 8,
          diffIndicators: "bars",
          diffStyle: "unified",
          disableFileHeader: false,
          expandUnchanged: false,
          hunkSeparators: "line-info",
          lineDiffType: "none",
          overflow: "scroll",
          stickyHeaders: true,
          theme: DIFF_THEME_NAME,
          themeType: resolvedScheme,
          unsafeCSS: DIFF_UNSAFE_CSS
        }}
        renderCustomHeader={renderHeader}
        style={diffStyleVariables(codeVariant)}
      />
    </div>
  );
}
