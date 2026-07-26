import {
  Copy,
  FileUp,
  Monitor,
  Moon,
  Sun
} from "lucide-react";
import { ChangeEvent, CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  AppearanceMode,
  ColorScheme,
  ThemeColors,
  ThemePack,
  ThemeVariant
} from "../../../shared/contracts/theme";
import {
  CODE_FONT_STACKS,
  isHexColor,
  UI_FONT_STACKS,
  validateThemePack
} from "../../../shared/themeCatalog";
import { createThemeCopy, shadowCssVariables, useTheme } from "../../theme/ThemeProvider";
import { desktopBridge } from "../../platform/desktop";

const primaryColorRows: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: "accent", label: "强调色" },
  { key: "background", label: "背景" },
  { key: "foreground", label: "前景" }
];

const appearanceModes: Array<{ icon: typeof Monitor; id: AppearanceMode; label: string }> = [
  { icon: Monitor, id: "system", label: "跟随系统" },
  { icon: Sun, id: "light", label: "浅色" },
  { icon: Moon, id: "dark", label: "深色" }
];

function previewVariables(variant: ThemeVariant): CSSProperties {
  return {
    "--preview-accent": variant.colors.accent,
    "--preview-added": variant.code.added,
    "--preview-added-gutter": variant.code.addedGutter,
    "--preview-background": variant.colors.background,
    "--preview-border": variant.colors.border,
    "--preview-code-background": variant.code.background,
    "--preview-code-foreground": variant.code.foreground,
    "--preview-comment": variant.code.comment,
    "--preview-foreground": variant.colors.foreground,
    "--preview-keyword": variant.code.keyword,
    "--preview-muted": variant.colors.muted,
    "--preview-number": variant.code.number,
    "--preview-removed": variant.code.removed,
    "--preview-removed-gutter": variant.code.removedGutter,
    "--preview-string": variant.code.string,
    "--preview-surface": variant.colors.surface,
    "--preview-type": variant.code.type,
    fontFamily: variant.typography.codeFont
  } as CSSProperties;
}

function AppearanceCard({
  active,
  mode,
  onSelect
}: {
  active: boolean;
  mode: typeof appearanceModes[number];
  onSelect: () => void;
}) {
  const Icon = mode.icon;
  return (
    <button aria-pressed={active} className={`appearance-mode-card is-${mode.id} ${active ? "is-active" : ""}`} onClick={onSelect} type="button">
      <div className="appearance-mode-visual">
        <div className="appearance-mode-window">
          <span />
          <span />
          <span />
        </div>
        {mode.id === "system" && <div className="appearance-mode-split" />}
      </div>
      <span><Icon size={14} />{mode.label}</span>
    </button>
  );
}

function DiffPreview({ variant }: { variant: ThemeVariant }) {
  const declaration = (
    <>
      <span className="token-keyword">const</span>
      <span> themePreview</span>
      <span className="token-punctuation">: </span>
      <span className="token-type">ThemeConfig</span>
      <span className="token-punctuation"> = {"{"}</span>
    </>
  );
  const property = (name: string, value: string | number) => (
    <>
      <span>  {name}</span>
      <span className="token-punctuation">: </span>
      {typeof value === "number"
        ? <span className="token-number">{value}</span>
        : <span className="token-string">"{value}"</span>}
      <span className="token-punctuation">,</span>
    </>
  );
  return (
    <div className="theme-diff-preview" style={previewVariables(variant)}>
      <div className="theme-diff-column is-removed">
        <div className="theme-diff-line"><span>1</span><code>{declaration}</code></div>
        <div className="theme-diff-line is-change"><span>2</span><code>{property("surface", "sidebar")}</code></div>
        <div className="theme-diff-line is-change"><span>3</span><code>{property("accent", "#2563eb")}</code></div>
        <div className="theme-diff-line is-change"><span>4</span><code>{property("contrast", 42)}</code></div>
        <div className="theme-diff-line"><span>5</span><code><span className="token-punctuation">{"};"}</span></code></div>
      </div>
      <div className="theme-diff-column is-added">
        <div className="theme-diff-line"><span>1</span><code>{declaration}</code></div>
        <div className="theme-diff-line is-change"><span>2</span><code>{property("surface", "sidebar-elevated")}</code></div>
        <div className="theme-diff-line is-change"><span>3</span><code>{property("accent", "#0ea5e9")}</code></div>
        <div className="theme-diff-line is-change"><span>4</span><code>{property("contrast", 68)}</code></div>
        <div className="theme-diff-line"><span>5</span><code><span className="token-punctuation">{"};"}</span></code></div>
      </div>
    </div>
  );
}

function ColorControl({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value.slice(0, 7)) ? value.slice(0, 7) : "#000000";
  return (
    <label className="theme-field-row">
      <span>{label}</span>
      <span
        className={`theme-color-control ${isHexColor(value) ? "" : "is-invalid"}`}
        style={isHexColor(value) ? {
          background: value,
          color: relativeLuminance(value) > 0.45 ? "#20272A" : "#FFFFFF"
        } : undefined}
      >
        <input aria-label={`${label}颜色`} onChange={(event) => onChange(event.target.value)} type="color" value={pickerValue} />
        <input aria-label={`${label}颜色值`} maxLength={9} onChange={(event) => onChange(event.target.value)} spellCheck={false} type="text" value={value} />
      </span>
    </label>
  );
}

function relativeLuminance(color: string): number {
  const normalized = color.slice(1, 7);
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function AppearanceSettings() {
  const {
    activeTheme,
    activeVariant,
    importTheme,
    preference,
    previewTheme: draft,
    resolvedScheme,
    saveTheme,
    setPreference,
    setPreviewTheme: setDraft,
    themes
  } = useTheme();
  const [editingScheme, setEditingScheme] = useState<ColorScheme>(resolvedScheme);
  const [busy, setBusy] = useState(false);
  const browserImportRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (preference.mode !== "system") setEditingScheme(preference.mode);
    else setEditingScheme(resolvedScheme);
  }, [preference.mode, resolvedScheme]);

  const variant = draft.variants[editingScheme];
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(activeTheme), [activeTheme, draft]);

  useEffect(() => {
    if (editingScheme !== resolvedScheme) return;
    const root = document.documentElement;
    const previewShadows = shadowCssVariables(variant);
    for (const [name, value] of Object.entries(previewShadows)) root.style.setProperty(name, value);
    return () => {
      const activeShadows = shadowCssVariables(activeVariant);
      for (const [name, value] of Object.entries(activeShadows)) root.style.setProperty(name, value);
    };
  }, [activeVariant, editingScheme, resolvedScheme, variant]);

  const mutateDraft = (update: (next: ThemePack) => void) => {
    setDraft((current) => {
      const next = current.readonly ? createThemeCopy(current) : structuredClone(current);
      update(next);
      return next;
    });
  };

  const setColor = (key: keyof ThemeColors, value: string) => {
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      mutateDraft((next) => { next.variants[editingScheme].colors[key] = value; });
      return;
    }
    mutateDraft((next) => { next.variants[editingScheme].colors[key] = value.toUpperCase(); });
  };

  const chooseMode = async (mode: AppearanceMode) => {
    await setPreference({ ...preference, mode });
    if (mode !== "system") setEditingScheme(mode);
  };

  const chooseTheme = async (themeId: string) => {
    const selected = themes.find((theme) => theme.id === themeId);
    if (!selected) return;
    setDraft(structuredClone(selected));
    await setPreference({ ...preference, themeId });
  };

  const startImport = async (file?: File) => {
    setBusy(true);
    try {
      const imported = await importTheme(editingScheme, file);
      if (imported) setDraft(imported);
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  };

  const handleBrowserImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void startImport(file);
  };

  useEffect(() => {
    if (!dirty || draft.readonly) return;
    try {
      validateThemePack(draft);
    } catch {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void saveTheme(draft, true)
        .then((saved) => {
          if (!cancelled) setDraft(structuredClone(saved));
        })
        .catch((error) => console.error(error))
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 420);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dirty, draft, saveTheme, setDraft]);

  return (
    <section className="settings-page appearance-settings">
      <header className="settings-page-header">
        <h1>外观</h1>
        <p>选择界面模式，并统一调整应用与代码的视觉主题。</p>
      </header>
      <section className="appearance-section">
        <h2>主题</h2>
        <div className="appearance-mode-grid">
          {appearanceModes.map((mode) => (
            <AppearanceCard active={preference.mode === mode.id} key={mode.id} mode={mode} onSelect={() => void chooseMode(mode.id)} />
          ))}
        </div>
        <DiffPreview variant={variant} />
      </section>

      <section className="theme-editor-panel" style={previewVariables(variant)}>
        <header className="theme-editor-header">
          <strong>{editingScheme === "light" ? "浅色主题" : "深色主题"}</strong>
          <div className="theme-editor-actions">
            <button disabled={busy} onClick={() => desktopBridge() ? void startImport() : browserImportRef.current?.click()} type="button"><FileUp size={14} />导入</button>
            <button onClick={() => setDraft(createThemeCopy(draft))} type="button"><Copy size={14} />复制主题</button>
            <select aria-label="选择主题" onChange={(event) => void chooseTheme(event.target.value)} value={draft.readonly ? draft.id : themes.some((theme) => theme.id === draft.id) ? draft.id : ""}>
              {!themes.some((theme) => theme.id === draft.id) && <option value="">{draft.name}</option>}
              {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
            </select>
            <input accept=".json,.jsonc" hidden onChange={handleBrowserImport} ref={browserImportRef} type="file" />
          </div>
        </header>
        <div className="theme-scheme-tabs">
          <button className={editingScheme === "light" ? "is-active" : ""} onClick={() => setEditingScheme("light")} type="button">浅色</button>
          <button className={editingScheme === "dark" ? "is-active" : ""} onClick={() => setEditingScheme("dark")} type="button">深色</button>
        </div>
        {!draft.readonly && (
          <label className="theme-field-row">
            <span>主题名称</span>
            <input
              className="theme-name-input"
              maxLength={80}
              onChange={(event) => {
                const name = event.currentTarget.value;
                mutateDraft((next) => { next.name = name; });
              }}
              value={draft.name}
            />
          </label>
        )}
        {primaryColorRows.map((row) => <ColorControl key={row.key} label={row.label} onChange={(value) => setColor(row.key, value)} value={variant.colors[row.key]} />)}
        <label className="theme-field-row">
          <span>UI 字体</span>
          <select
            onChange={(event) => {
              const font = event.currentTarget.value;
              mutateDraft((next) => { next.variants[editingScheme].typography.uiFont = font; });
            }}
            value={variant.typography.uiFont}
          >
            {UI_FONT_STACKS.map((font) => <option key={font.id} value={font.value}>{font.label}</option>)}
          </select>
        </label>
        <label className="theme-field-row">
          <span>代码字体</span>
          <select
            onChange={(event) => {
              const font = event.currentTarget.value;
              mutateDraft((next) => { next.variants[editingScheme].typography.codeFont = font; });
            }}
            value={variant.typography.codeFont}
          >
            {CODE_FONT_STACKS.map((font) => <option key={font.id} value={font.value}>{font.label}</option>)}
          </select>
        </label>
        <label className="theme-field-row">
          <span>对比度</span>
          <span className="theme-range-control">
            <input
              aria-label="界面阴影与层级对比度"
              max={100}
              min={0}
              onInput={(event) => {
                const contrast = Number(event.currentTarget.value);
                mutateDraft((next) => {
                  next.variants[editingScheme].contrast = contrast;
                });
              }}
              type="range"
              value={variant.contrast}
            />
            <output>{variant.contrast}</output>
          </span>
        </label>
      </section>
    </section>
  );
}
