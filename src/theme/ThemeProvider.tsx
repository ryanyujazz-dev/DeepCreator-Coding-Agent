import { PrismTheme } from "prism-react-renderer";
import {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  ColorScheme,
  ThemePack,
  ThemePreference,
  ThemeVariant
} from "../../shared/contracts/theme";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_PREFERENCE,
  cloneTheme,
  normalizeThemePreference,
  resolveColorScheme,
  themeById,
  validateThemePack
} from "../../shared/themeCatalog";

const CACHE_KEY = "deepseeker.themeCache.v1";

type ThemeCache = {
  preference: ThemePreference;
  themes: ThemePack[];
};

type ThemeContextValue = {
  activeTheme: ThemePack;
  activeVariant: ThemeVariant;
  codeTheme: ThemePack;
  codeVariant: ThemeVariant;
  exportTheme: (themeId: string) => Promise<void>;
  importTheme: (target: ColorScheme, file?: File) => Promise<ThemePack | null>;
  preference: ThemePreference;
  previewTheme: ThemePack;
  prismTheme: PrismTheme;
  removeTheme: (themeId: string) => Promise<void>;
  resolvedScheme: ColorScheme;
  saveTheme: (theme: ThemePack, apply?: boolean) => Promise<ThemePack>;
  setPreference: (preference: ThemePreference) => Promise<void>;
  setPreviewTheme: Dispatch<SetStateAction<ThemePack>>;
  systemDark: boolean;
  themes: ThemePack[];
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readCache(): ThemeCache {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "{}") as Partial<ThemeCache>;
    const custom = Array.isArray(parsed.themes)
      ? parsed.themes.map((theme) => {
          try {
            const validated = validateThemePack(theme);
            return validated.readonly ? null : validated;
          } catch {
            return null;
          }
        }).filter((theme): theme is ThemePack => Boolean(theme))
      : [];
    return {
      preference: normalizeThemePreference(parsed.preference),
      themes: [...structuredClone(BUILTIN_THEMES), ...custom]
    };
  } catch {
    return {
      preference: DEFAULT_THEME_PREFERENCE,
      themes: structuredClone(BUILTIN_THEMES)
    };
  }
}

function saveCache(preference: ThemePreference, themes: ThemePack[]): void {
  window.localStorage.setItem(CACHE_KEY, JSON.stringify({
    preference,
    themes: themes.filter((theme) => !theme.readonly)
  }));
}

function colorLuminance(color: string): number {
  const match = color.match(/^#([0-9a-f]{6})/i);
  if (!match) return 1;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function shadowColor(dark: boolean, opacity: number): string {
  const channels = dark ? "0 0 0" : "20 31 43";
  return `rgb(${channels} / ${(opacity * 100).toFixed(1)}%)`;
}

export function shadowCssVariables(variant: ThemeVariant): Record<string, string> {
  const canvasLuminance = colorLuminance(variant.colors.background);
  const chromeLuminance = colorLuminance(variant.colors.sidebar);
  const dark = canvasLuminance < 0.25;
  const configuredStrength = Math.max(0, Math.min(100, variant.contrast)) / 100;
  const referenceSeparation = dark ? 0.011 : 0.16;
  const surfaceSeparation = Math.abs(canvasLuminance - chromeLuminance);
  const separationDeficit = Math.max(0, Math.min(1, (referenceSeparation - surfaceSeparation) / referenceSeparation));
  const perceptualCompensation = 1 + separationDeficit * 0.75;
  const canvasStrength = Math.min(1, configuredStrength * perceptualCompensation);
  return {
    "--shadow-canvas-faint-color": shadowColor(dark, 0.08 * canvasStrength),
    "--shadow-canvas-soft-color": shadowColor(dark, 0.18 * canvasStrength),
    "--shadow-faint-color": shadowColor(dark, 0.08 * configuredStrength),
    "--shadow-soft-color": shadowColor(dark, 0.18 * configuredStrength),
    "--shadow-strong-color": shadowColor(dark, 0.32 * configuredStrength)
  };
}

function cssVariables(variant: ThemeVariant, codeVariant: ThemeVariant): Record<string, string> {
  const { colors, contrast, typography } = variant;
  const { code } = codeVariant;
  const secondaryWeight = Math.round(42 + contrast * 0.38);
  const borderWeight = Math.round(7 + contrast * 0.13);
  return {
    ...shadowCssVariables(variant),
    "--app-border": colors.border,
    "--app-canvas": colors.background,
    "--app-chrome": colors.sidebar,
    "--app-sidebar": colors.sidebar,
    "--app-sidebar-hover": colors.hover,
    "--app-text": colors.foreground,
    "--app-text-muted": colors.muted,
    "--code-added": code.added,
    "--code-added-gutter": code.addedGutter,
    "--code-background": code.background,
    "--code-foreground": code.foreground,
    "--code-removed": code.removed,
    "--code-removed-gutter": code.removedGutter,
    "--color-border": `color-mix(in srgb, ${colors.foreground} ${borderWeight}%, transparent)`,
    "--color-control-idle": colors.subtle,
    "--color-danger": colors.danger,
    "--color-danger-surface": colors.dangerSurface,
    "--color-hover": colors.hover,
    "--color-success": colors.success,
    "--color-surface": colors.surface,
    "--color-surface-elevated": colors.surfaceElevated,
    "--color-surface-subtle": colors.surfaceSubtle,
    "--color-text": colors.foreground,
    "--color-text-muted": colors.muted,
    "--color-text-secondary": `color-mix(in srgb, ${colors.foreground} ${secondaryWeight}%, ${colors.background})`,
    "--color-text-subtle": colors.subtle,
    "--color-warning": colors.warning,
    "--conversation-bg": colors.background,
    "--font-family-code": codeVariant.typography.codeFont,
    "--font-family-ui": typography.uiFont,
    "--focus-ring": `0 0 0 3px color-mix(in srgb, ${colors.accent} 20%, transparent)`,
    "--theme-blue": colors.accent,
    "--theme-blue-dark": colors.accentHover,
    "--theme-blue-darker": colors.accentHover,
    "--theme-blue-gray-hover": colors.hover,
    "--theme-blue-gray-surface": colors.surfaceSubtle,
    "--theme-blue-light": colors.selected,
    "--theme-blue-muted": colors.muted,
    "--theme-border-explicit": colors.border,
    "--theme-contrast": String(contrast)
  };
}

function prismTheme(variant: ThemeVariant): PrismTheme {
  return {
    plain: {
      backgroundColor: variant.code.background,
      color: variant.code.foreground
    },
    styles: [
      { style: { color: variant.code.comment }, types: ["comment", "prolog", "doctype", "cdata"] },
      { style: { color: variant.code.keyword }, types: ["keyword", "operator", "boolean", "important"] },
      { style: { color: variant.code.string }, types: ["string", "char", "attr-value", "regex"] },
      { style: { color: variant.code.number }, types: ["number", "constant", "symbol"] },
      { style: { color: variant.code.type }, types: ["class-name", "builtin", "function"] },
      { style: { color: variant.colors.danger }, types: ["deleted"] },
      { style: { color: variant.colors.success }, types: ["inserted"] },
      { style: { color: variant.code.foreground }, types: ["punctuation", "property", "tag", "selector"] }
    ]
  };
}

async function browserImport(file: File, baseTheme: ThemePack): Promise<ThemePack> {
  if (file.size > 512 * 1024) throw new Error("主题文件超过 512KB。");
  const parsed = JSON.parse(await file.text()) as unknown;
  if (!parsed || typeof parsed !== "object" || !("schemaVersion" in parsed)) {
    throw new Error("浏览器开发模式仅支持 DeepSeeker 主题 JSON；VS Code JSONC 请在桌面端导入。");
  }
  const theme = validateThemePack(parsed);
  return validateThemePack({
    ...theme,
    id: `imported-${Date.now().toString(36)}`,
    name: theme.name || `${baseTheme.name} 副本`,
    readonly: false,
    source: "imported"
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readCache, []);
  const [preference, setPreferenceState] = useState(initial.preference);
  const [themes, setThemes] = useState(initial.themes);
  const [previewTheme, setPreviewTheme] = useState(() => structuredClone(themeById(initial.themes, initial.preference.themeId)));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedScheme = resolveColorScheme(preference.mode, systemDark);
  const activeTheme = themeById(themes, preference.themeId);
  const codeTheme = activeTheme;
  const activeVariant = activeTheme.variants[resolvedScheme];
  const codeVariant = activeVariant;

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!window.deepseeker) return;
    void Promise.all([
      window.deepseeker.appearance.read(),
      window.deepseeker.themes.list()
    ]).then(async ([storedPreference, summaries]) => {
      const loaded = await Promise.all(summaries.map((summary) => window.deepseeker!.themes.get(summary.id)));
      const available = loaded.filter((theme): theme is ThemePack => Boolean(theme));
      setThemes(available.length > 0 ? available : structuredClone(BUILTIN_THEMES));
      setPreferenceState(storedPreference);
      setPreviewTheme(structuredClone(themeById(
        available.length > 0 ? available : BUILTIN_THEMES,
        storedPreference.themeId
      )));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const variables = cssVariables(activeVariant, codeVariant);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    root.dataset.colorScheme = resolvedScheme;
    root.dataset.theme = activeTheme.id;
    root.dataset.translucentSidebar = String(activeVariant.translucentSidebar);
    root.style.colorScheme = resolvedScheme;
    saveCache(preference, themes);
    void window.deepseeker?.appearance.applyChrome({
      backgroundColor: activeVariant.colors.sidebar,
      mode: preference.mode,
      symbolColor: activeVariant.colors.muted,
      translucentSidebar: activeVariant.translucentSidebar
    }).catch(() => undefined);
  }, [activeTheme.id, activeVariant, codeVariant, preference, resolvedScheme, themes]);

  const setPreference = useCallback(async (next: ThemePreference) => {
    const normalized = {
      mode: next.mode,
      themeId: next.themeId
    };
    setPreferenceState(normalized);
    saveCache(normalized, themes);
    if (window.deepseeker) await window.deepseeker.appearance.save(normalized);
  }, [themes]);

  const saveTheme = useCallback(async (input: ThemePack, apply = false) => {
    const theme = validateThemePack(input);
    const saved = window.deepseeker ? await window.deepseeker.themes.save(theme) : theme;
    const nextThemes = [...themes.filter((candidate) => candidate.id !== saved.id), saved];
    setThemes(nextThemes);
    saveCache(preference, nextThemes);
    if (apply) {
      const nextPreference = { ...preference, themeId: saved.id };
      setPreferenceState(nextPreference);
      if (window.deepseeker) await window.deepseeker.appearance.save(nextPreference);
    }
    return saved;
  }, [preference, themes]);

  const removeTheme = useCallback(async (themeId: string) => {
    if (window.deepseeker) await window.deepseeker.themes.remove(themeId);
    const nextThemes = themes.filter((theme) => theme.id !== themeId);
    const nextPreference = {
      ...preference,
      codeThemeId: preference.codeThemeId === themeId ? undefined : preference.codeThemeId,
      themeId: preference.themeId === themeId ? DEFAULT_THEME_PREFERENCE.themeId : preference.themeId
    };
    setThemes(nextThemes);
    setPreferenceState(nextPreference);
    saveCache(nextPreference, nextThemes);
    if (window.deepseeker) await window.deepseeker.appearance.save(nextPreference);
  }, [preference, themes]);

  const importTheme = useCallback(async (target: ColorScheme, file?: File) => {
    if (window.deepseeker) {
      return window.deepseeker.themes.importFile({ baseThemeId: activeTheme.id, target });
    }
    if (!file) return null;
    return browserImport(file, activeTheme);
  }, [activeTheme]);

  const exportTheme = useCallback(async (themeId: string) => {
    if (window.deepseeker) {
      await window.deepseeker.themes.exportFile(themeId);
      return;
    }
    const theme = themeById(themes, themeId);
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(theme, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${theme.name}.deepseeker-theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [themes]);

  const value = useMemo<ThemeContextValue>(() => ({
    activeTheme,
    activeVariant,
    codeTheme,
    codeVariant,
    exportTheme,
    importTheme,
    preference,
    previewTheme,
    prismTheme: prismTheme(codeVariant),
    removeTheme,
    resolvedScheme,
    saveTheme,
    setPreference,
    setPreviewTheme,
    systemDark,
    themes
  }), [
    activeTheme,
    activeVariant,
    codeTheme,
    codeVariant,
    exportTheme,
    importTheme,
    preference,
    previewTheme,
    removeTheme,
    resolvedScheme,
    saveTheme,
    setPreference,
    systemDark,
    themes
  ]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider.");
  return value;
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

export function createThemeCopy(theme: ThemePack): ThemePack {
  return cloneTheme(
    theme,
    `custom-${Date.now().toString(36)}`,
    `${theme.name} 副本`
  );
}
