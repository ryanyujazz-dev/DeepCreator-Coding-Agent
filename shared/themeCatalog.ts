import {
  CodeColors,
  ColorScheme,
  ThemeColors,
  ThemePack,
  ThemePreference,
  ThemeTypography,
  ThemeVariant
} from "./contracts/theme";

export const DEFAULT_THEME_ID = "deepseeker";
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_PREFERENCE: ThemePreference = {
  mode: "system",
  themeId: DEFAULT_THEME_ID
};

export const UI_FONT_STACKS = [
  {
    id: "harmony",
    label: "HarmonyOS Sans",
    value: '"HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif'
  },
  {
    id: "system",
    label: "系统界面字体",
    value: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  {
    id: "humanist",
    label: "Humanist",
    value: '"Segoe UI", "HarmonyOS Sans SC", "PingFang SC", sans-serif'
  }
] as const;

export const CODE_FONT_STACKS = [
  {
    id: "system-mono",
    label: "系统等宽字体",
    value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  },
  {
    id: "menlo",
    label: "Menlo",
    value: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  },
  {
    id: "sf-mono",
    label: "SF Mono",
    value: '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace'
  }
] as const;

const defaultTypography: ThemeTypography = {
  codeFont: CODE_FONT_STACKS[0].value,
  uiFont: UI_FONT_STACKS[0].value
};

function variant(
  colors: ThemeColors,
  code: CodeColors,
  options: Partial<Pick<ThemeVariant, "contrast" | "translucentSidebar" | "typography">> = {}
): ThemeVariant {
  return {
    code,
    colors,
    contrast: options.contrast ?? 50,
    translucentSidebar: options.translucentSidebar ?? false,
    typography: options.typography ?? defaultTypography
  };
}

const deepseekerLightColors: ThemeColors = {
  accent: "#3188f4",
  accentHover: "#2378ec",
  background: "#fbfbfa",
  border: "#e1e5e7",
  chrome: "#f2f4f5",
  danger: "#c83f39",
  dangerSurface: "#fdeaea",
  foreground: "#282f33",
  hover: "#e9edf0",
  muted: "#778188",
  selected: "#e8f2ff",
  sidebar: "#d9ebf1",
  subtle: "#929aa0",
  success: "#159447",
  surface: "#ffffff",
  surfaceElevated: "#ffffff",
  surfaceSubtle: "#f5f6f7",
  warning: "#a66b12"
};

const deepseekerDarkColors: ThemeColors = {
  accent: "#5ca2ff",
  accentHover: "#78b3ff",
  background: "#111619",
  border: "#2c373d",
  chrome: "#171d21",
  danger: "#ff7b72",
  dangerSurface: "#3b2223",
  foreground: "#e7ecef",
  hover: "#263137",
  muted: "#6b7980",
  selected: "#203a54",
  sidebar: "#18272e",
  subtle: "#526067",
  success: "#56d182",
  surface: "#151b1f",
  surfaceElevated: "#1b2328",
  surfaceSubtle: "#20292e",
  warning: "#e3b341"
};

const githubLightColors: ThemeColors = {
  accent: "#0969da",
  accentHover: "#0550ae",
  background: "#ffffff",
  border: "#d0d7de",
  chrome: "#f6f8fa",
  danger: "#cf222e",
  dangerSurface: "#ffebe9",
  foreground: "#1f2328",
  hover: "#f3f4f6",
  muted: "#656d76",
  selected: "#ddf4ff",
  sidebar: "#f6f8fa",
  subtle: "#8c959f",
  success: "#1a7f37",
  surface: "#ffffff",
  surfaceElevated: "#ffffff",
  surfaceSubtle: "#f6f8fa",
  warning: "#9a6700"
};

const githubDarkColors: ThemeColors = {
  accent: "#58a6ff",
  accentHover: "#79c0ff",
  background: "#0d1117",
  border: "#30363d",
  chrome: "#161b22",
  danger: "#ff7b72",
  dangerSurface: "#3d1f24",
  foreground: "#e6edf3",
  hover: "#21262d",
  muted: "#818b96",
  selected: "#1f3b57",
  sidebar: "#161b22",
  subtle: "#5e6872",
  success: "#3fb950",
  surface: "#0d1117",
  surfaceElevated: "#161b22",
  surfaceSubtle: "#21262d",
  warning: "#d29922"
};

const githubLightCode: CodeColors = {
  added: "#dafbe1",
  addedGutter: "#1f883d",
  background: "#ffffff",
  comment: "#6e7781",
  foreground: "#24292f",
  keyword: "#cf222e",
  lineHighlight: "#f6f8fa",
  lineNumber: "#6e7781",
  number: "#0550ae",
  removed: "#ffebe9",
  removedGutter: "#cf222e",
  selection: "#add6ff80",
  string: "#0a3069",
  type: "#8250df"
};

const githubDarkCode: CodeColors = {
  added: "#1b4721",
  addedGutter: "#3fb950",
  background: "#0d1117",
  comment: "#8b949e",
  foreground: "#e6edf3",
  keyword: "#ff7b72",
  lineHighlight: "#161b22",
  lineNumber: "#7d8590",
  number: "#79c0ff",
  removed: "#4c1e24",
  removedGutter: "#f85149",
  selection: "#264f78",
  string: "#a5d6ff",
  type: "#d2a8ff"
};

const deepseekerLightCode: CodeColors = {
  ...githubLightCode,
  background: "#F3F7FA",
  lineHighlight: "#EAF1F6",
  selection: "#BBDDFC80"
};

const deepseekerDarkCode: CodeColors = {
  ...githubDarkCode,
  background: "#10171C",
  lineHighlight: "#182229",
  selection: "#244D7080"
};

const DEFAULT_LIGHT_CONTRAST = 50;
const DEFAULT_DARK_CONTRAST = 58;

export const BUILTIN_THEMES: ThemePack[] = [
  {
    id: DEFAULT_THEME_ID,
    name: "DeepSeeker",
    readonly: true,
    schemaVersion: 1,
    source: "builtin",
    variants: {
      dark: variant(deepseekerDarkColors, deepseekerDarkCode, {
        contrast: DEFAULT_DARK_CONTRAST,
        translucentSidebar: true
      }),
      light: variant(deepseekerLightColors, deepseekerLightCode, {
        contrast: DEFAULT_LIGHT_CONTRAST,
        translucentSidebar: true
      })
    }
  },
  {
    id: "github",
    name: "GitHub",
    readonly: true,
    schemaVersion: 1,
    source: "builtin",
    variants: {
      dark: variant(githubDarkColors, githubDarkCode, { contrast: DEFAULT_DARK_CONTRAST }),
      light: variant(githubLightColors, githubLightCode, { contrast: DEFAULT_LIGHT_CONTRAST })
    }
  }
];

const COLOR_KEYS: Array<keyof ThemeColors> = [
  "accent",
  "accentHover",
  "background",
  "border",
  "chrome",
  "danger",
  "dangerSurface",
  "foreground",
  "hover",
  "muted",
  "selected",
  "sidebar",
  "subtle",
  "success",
  "surface",
  "surfaceElevated",
  "surfaceSubtle",
  "warning"
];

const CODE_COLOR_KEYS: Array<keyof CodeColors> = [
  "added",
  "addedGutter",
  "background",
  "comment",
  "foreground",
  "keyword",
  "lineHighlight",
  "lineNumber",
  "number",
  "removed",
  "removedGutter",
  "selection",
  "string",
  "type"
];

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_THEME_PREFERENCE);
  const input = value as Record<string, unknown>;
  return {
    codeThemeId: typeof input.codeThemeId === "string" && input.codeThemeId.trim() ? input.codeThemeId.trim() : undefined,
    mode: input.mode === "light" || input.mode === "dark" ? input.mode : "system",
    themeId: typeof input.themeId === "string" && input.themeId.trim() ? input.themeId.trim() : DEFAULT_THEME_ID
  };
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
}

function validateColorRecord<T extends Record<string, string>>(
  value: unknown,
  keys: Array<keyof T>,
  label: string
): T {
  if (!value || typeof value !== "object") throw new Error(`${label} 缺失。`);
  const record = value as Record<string, unknown>;
  const output: Partial<T> = {};
  for (const key of keys) {
    if (!isHexColor(record[String(key)])) throw new Error(`${label}.${String(key)} 不是有效的十六进制颜色。`);
    output[key] = record[String(key)] as T[keyof T];
  }
  return output as T;
}

function migrateThemePack(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const input = structuredClone(value) as Record<string, unknown>;
  if (input.schemaVersion === THEME_SCHEMA_VERSION) return input;
  if (input.schemaVersion !== 0 && input.schemaVersion !== undefined) return input;
  if (!input.variants || typeof input.variants !== "object") return input;
  const variants = input.variants as Record<string, unknown>;
  for (const scheme of ["light", "dark"] as const) {
    const raw = variants[scheme];
    if (!raw || typeof raw !== "object") continue;
    const variant = raw as Record<string, unknown>;
    variant.contrast ??= 50;
    variant.translucentSidebar ??= false;
    variant.typography ??= structuredClone(defaultTypography);
  }
  input.readonly ??= false;
  input.schemaVersion = THEME_SCHEMA_VERSION;
  input.source ??= "custom";
  return input;
}

export function validateThemePack(value: unknown): ThemePack {
  const migrated = migrateThemePack(value);
  if (!migrated || typeof migrated !== "object") throw new Error("主题文件必须是对象。");
  const input = migrated as Record<string, unknown>;
  if (input.schemaVersion !== THEME_SCHEMA_VERSION) throw new Error("不支持的主题 schemaVersion。");
  if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(input.id)) {
    throw new Error("主题 ID 无效。");
  }
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > 80) {
    throw new Error("主题名称必须为 1–80 个字符。");
  }
  if (!input.variants || typeof input.variants !== "object") throw new Error("主题缺少明暗变体。");
  const variants = input.variants as Record<string, unknown>;
  const normalized = {} as Record<ColorScheme, ThemeVariant>;
  for (const scheme of ["light", "dark"] as const) {
    const raw = variants[scheme] as Record<string, unknown> | undefined;
    if (!raw) throw new Error(`主题缺少 ${scheme} 变体。`);
    const contrast = Number(raw.contrast);
    const typography = raw.typography as Record<string, unknown> | undefined;
    if (!Number.isFinite(contrast) || contrast < 0 || contrast > 100) throw new Error(`${scheme}.contrast 必须在 0–100 之间。`);
    if (!typography || typeof typography.uiFont !== "string" || typeof typography.codeFont !== "string") {
      throw new Error(`${scheme}.typography 无效。`);
    }
    const allowedUiFonts = new Set(UI_FONT_STACKS.map((font) => font.value));
    const allowedCodeFonts = new Set(CODE_FONT_STACKS.map((font) => font.value));
    if (!allowedUiFonts.has(typography.uiFont as typeof UI_FONT_STACKS[number]["value"])) throw new Error("UI 字体不在安全字体栈中。");
    if (!allowedCodeFonts.has(typography.codeFont as typeof CODE_FONT_STACKS[number]["value"])) throw new Error("代码字体不在安全字体栈中。");
    normalized[scheme] = {
      code: validateColorRecord<CodeColors>(raw.code, CODE_COLOR_KEYS, `${scheme}.code`),
      colors: validateColorRecord<ThemeColors>(raw.colors, COLOR_KEYS, `${scheme}.colors`),
      contrast,
      translucentSidebar: Boolean(raw.translucentSidebar),
      typography: {
        codeFont: typography.codeFont,
        uiFont: typography.uiFont
      }
    };
  }
  return {
    id: input.id,
    name: input.name.trim(),
    readonly: Boolean(input.readonly),
    schemaVersion: 1,
    source: input.source === "builtin" || input.source === "imported" ? input.source : "custom",
    variants: normalized
  };
}

export function themeById(themes: ThemePack[], id: string): ThemePack {
  return themes.find((theme) => theme.id === id) ?? themes.find((theme) => theme.id === DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0];
}

export function resolveColorScheme(mode: ThemePreference["mode"], systemDark: boolean): ColorScheme {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

export function cloneTheme(theme: ThemePack, id: string, name: string): ThemePack {
  return validateThemePack({
    ...structuredClone(theme),
    id,
    name,
    readonly: false,
    source: "custom"
  });
}
