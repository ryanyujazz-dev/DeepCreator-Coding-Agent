import { readFileSync } from "node:fs";
import path from "node:path";
import { parse, ParseError, printParseErrorCode } from "jsonc-parser";
import { ColorScheme, ThemePack } from "../shared/contracts/theme";
import { cloneTheme, isHexColor, validateThemePack } from "../shared/themeCatalog";

const MAX_THEME_BYTES = 512 * 1024;
const MAX_INCLUDE_DEPTH = 5;

type VsCodeTokenRule = {
  scope?: string | string[];
  settings?: {
    foreground?: string;
  };
};

type VsCodeTheme = {
  colors?: Record<string, string>;
  include?: string;
  name?: string;
  tokenColors?: VsCodeTokenRule[];
  type?: ColorScheme;
};

function readJsonc(filePath: string): VsCodeTheme | ThemePack {
  const source = readFileSync(filePath);
  if (source.byteLength > MAX_THEME_BYTES) throw new Error("主题文件超过 512KB。");
  const errors: ParseError[] = [];
  const parsed = parse(source.toString("utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false
  }) as VsCodeTheme | ThemePack;
  if (errors.length > 0) {
    throw new Error(`主题 JSONC 无效：${errors.map((error) => printParseErrorCode(error.error)).join("、")}。`);
  }
  return parsed;
}

function mergeVsCodeTheme(filePath: string, depth = 0, visited = new Set<string>()): VsCodeTheme {
  const resolved = path.resolve(filePath);
  if (depth > MAX_INCLUDE_DEPTH) throw new Error("VS Code 主题 include 超过最大深度。");
  if (visited.has(resolved)) throw new Error("VS Code 主题 include 存在循环引用。");
  visited.add(resolved);
  const current = readJsonc(resolved) as VsCodeTheme;
  if (!current.include) return current;
  if (path.isAbsolute(current.include)) throw new Error("VS Code 主题 include 必须使用相对路径。");
  const includedPath = path.resolve(path.dirname(resolved), current.include);
  const relative = path.relative(path.dirname(resolved), includedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("VS Code 主题 include 不能离开主题目录。");
  const parent = mergeVsCodeTheme(includedPath, depth + 1, visited);
  return {
    ...parent,
    ...current,
    colors: { ...parent.colors, ...current.colors },
    tokenColors: [...(parent.tokenColors ?? []), ...(current.tokenColors ?? [])]
  };
}

function firstTokenColor(rules: VsCodeTokenRule[] | undefined, scopes: string[]): string | undefined {
  for (const rule of rules ?? []) {
    const values = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === "string" ? rule.scope.split(",") : [];
    if (!values.some((value) => scopes.some((scope) => value.trim() === scope || value.trim().startsWith(`${scope}.`)))) continue;
    if (isHexColor(rule.settings?.foreground)) return rule.settings.foreground;
  }
  return undefined;
}

function color(colors: Record<string, string> | undefined, key: string): string | undefined {
  const value = colors?.[key];
  return isHexColor(value) ? value : undefined;
}

function importedId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "theme";
  return `imported-${slug}-${Date.now().toString(36)}`;
}

export function importThemeFile(filePath: string, baseTheme: ThemePack, target: ColorScheme): ThemePack {
  const initial = readJsonc(filePath);
  if ("schemaVersion" in initial && initial.schemaVersion === 1 && "variants" in initial) {
    const parsed = validateThemePack(initial);
    return validateThemePack({
      ...parsed,
      id: importedId(parsed.name),
      readonly: false,
      source: "imported"
    });
  }

  const source = mergeVsCodeTheme(filePath);
  const name = source.name?.trim() || path.basename(filePath, path.extname(filePath));
  const imported = cloneTheme(baseTheme, importedId(name), name);
  imported.source = "imported";
  const variant = imported.variants[target];
  const colors = source.colors;

  variant.colors.background = color(colors, "editor.background") ?? variant.colors.background;
  variant.colors.foreground = color(colors, "editor.foreground") ?? variant.colors.foreground;
  variant.colors.sidebar = color(colors, "sideBar.background") ?? variant.colors.sidebar;
  variant.colors.chrome = color(colors, "titleBar.activeBackground") ?? variant.colors.chrome;
  variant.colors.border = color(colors, "panel.border") ?? color(colors, "focusBorder") ?? variant.colors.border;
  variant.colors.surface = color(colors, "editor.background") ?? variant.colors.surface;
  variant.colors.surfaceSubtle = color(colors, "editorWidget.background") ?? variant.colors.surfaceSubtle;
  variant.colors.selected = color(colors, "list.activeSelectionBackground") ?? variant.colors.selected;
  variant.colors.hover = color(colors, "list.hoverBackground") ?? variant.colors.hover;
  variant.colors.accent = color(colors, "focusBorder") ?? color(colors, "textLink.foreground") ?? variant.colors.accent;

  variant.code.background = color(colors, "editor.background") ?? variant.code.background;
  variant.code.foreground = color(colors, "editor.foreground") ?? variant.code.foreground;
  variant.code.lineNumber = color(colors, "editorLineNumber.foreground") ?? variant.code.lineNumber;
  variant.code.lineHighlight = color(colors, "editor.lineHighlightBackground") ?? variant.code.lineHighlight;
  variant.code.selection = color(colors, "editor.selectionBackground") ?? variant.code.selection;
  variant.code.added = color(colors, "diffEditor.insertedLineBackground") ?? variant.code.added;
  variant.code.removed = color(colors, "diffEditor.removedLineBackground") ?? variant.code.removed;
  variant.code.comment = firstTokenColor(source.tokenColors, ["comment"]) ?? variant.code.comment;
  variant.code.keyword = firstTokenColor(source.tokenColors, ["keyword", "storage"]) ?? variant.code.keyword;
  variant.code.string = firstTokenColor(source.tokenColors, ["string"]) ?? variant.code.string;
  variant.code.number = firstTokenColor(source.tokenColors, ["constant.numeric"]) ?? variant.code.number;
  variant.code.type = firstTokenColor(source.tokenColors, ["entity.name.type", "support.type"]) ?? variant.code.type;
  return validateThemePack(imported);
}
