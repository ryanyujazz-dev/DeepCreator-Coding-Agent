export type AppearanceMode = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";
export type ThemeSource = "builtin" | "custom" | "imported";

export type ThemeColors = {
  accent: string;
  accentHover: string;
  background: string;
  border: string;
  chrome: string;
  danger: string;
  dangerSurface: string;
  foreground: string;
  hover: string;
  muted: string;
  selected: string;
  sidebar: string;
  subtle: string;
  success: string;
  surface: string;
  surfaceElevated: string;
  surfaceSubtle: string;
  warning: string;
};

export type CodeColors = {
  added: string;
  addedGutter: string;
  background: string;
  comment: string;
  foreground: string;
  keyword: string;
  lineHighlight: string;
  lineNumber: string;
  number: string;
  removed: string;
  removedGutter: string;
  selection: string;
  string: string;
  type: string;
};

export type ThemeTypography = {
  codeFont: string;
  uiFont: string;
};

export type ThemeVariant = {
  code: CodeColors;
  colors: ThemeColors;
  contrast: number;
  translucentSidebar: boolean;
  typography: ThemeTypography;
};

export type ThemePack = {
  id: string;
  name: string;
  readonly: boolean;
  schemaVersion: 1;
  source: ThemeSource;
  variants: Record<ColorScheme, ThemeVariant>;
};

export type ThemePreference = {
  codeThemeId?: string;
  mode: AppearanceMode;
  themeId: string;
};

export type ThemeSummary = {
  id: string;
  name: string;
  readonly: boolean;
  source: ThemeSource;
};

export type ThemeImportInput = {
  baseThemeId: string;
  target: ColorScheme;
};

export type WindowChromeTheme = {
  backgroundColor: string;
  mode: AppearanceMode;
  symbolColor: string;
  translucentSidebar: boolean;
};
