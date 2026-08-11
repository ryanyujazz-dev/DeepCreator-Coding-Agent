import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importThemeFile } from "../desktop/themeImport";
import {
  BUILTIN_THEMES,
  cloneTheme,
  normalizeThemePreference,
  resolveColorScheme,
  validateThemePack
} from "../shared/themeCatalog";
import { executionMutedColor, shadowCssVariables } from "../src/theme/ThemeProvider";

function relativeLuminance(color: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(color.slice(1, 7).slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left: string, right: string): number {
  const values = [relativeLuminance(left), relativeLuminance(right)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

test("validates and clones complete light and dark theme variants", () => {
  const source = BUILTIN_THEMES[0];
  const copy = cloneTheme(source, "custom-test", "测试主题");
  assert.equal(copy.readonly, false);
  assert.equal(copy.source, "custom");
  assert.equal(copy.variants.light.colors.accent, source.variants.light.colors.accent);
  assert.equal(copy.variants.dark.code.background, source.variants.dark.code.background);
  assert.deepEqual(validateThemePack(copy), copy);
});

test("keeps built-in themes on one shared elevation baseline", () => {
  const [deepcreator, github] = BUILTIN_THEMES;
  assert.equal(github.variants.light.contrast, deepcreator.variants.light.contrast);
  assert.equal(github.variants.dark.contrast, deepcreator.variants.dark.contrast);
});

test("keeps every dark semantic gray readable and brighter than its light counterpart", () => {
  for (const theme of BUILTIN_THEMES) {
    const light = theme.variants.light;
    const dark = theme.variants.dark;
    for (const role of ["muted", "subtle"] as const) {
      const lightContrast = contrastRatio(light.colors[role], light.colors.background);
      const darkContrast = contrastRatio(dark.colors[role], dark.colors.background);
      assert.ok(darkContrast >= 5.25, `${theme.id}.${role} is too dim in dark mode`);
      assert.ok(darkContrast > lightContrast, `${theme.id}.${role} did not brighten in dark mode`);
    }
    const lightExecutionContrast = contrastRatio(executionMutedColor(light), light.colors.background);
    const darkExecutionContrast = contrastRatio(executionMutedColor(dark), dark.colors.background);
    assert.ok(darkExecutionContrast >= 5.25, `${theme.id}.execution is too dim in dark mode`);
    assert.ok(darkExecutionContrast > lightExecutionContrast, `${theme.id}.execution did not brighten in dark mode`);
    assert.ok(
      contrastRatio(dark.colors.muted, dark.colors.background)
        > contrastRatio(dark.colors.subtle, dark.colors.background),
      `${theme.id} dark gray hierarchy is reversed`
    );
  }
});

test("compensates shadow strength when the canvas and chrome are visually close", () => {
  const [deepcreator, github] = BUILTIN_THEMES;
  const deepcreatorShadows = shadowCssVariables(deepcreator.variants.light);
  const githubShadows = shadowCssVariables(github.variants.light);
  assert.equal(deepcreatorShadows["--shadow-soft-color"], "rgb(20 31 43 / 9.0%)");
  assert.equal(githubShadows["--shadow-soft-color"], "rgb(20 31 43 / 9.0%)");
  assert.equal(deepcreatorShadows["--shadow-canvas-soft-color"], "rgb(20 31 43 / 9.0%)");
  assert.equal(githubShadows["--shadow-canvas-soft-color"], "rgb(20 31 43 / 13.1%)");
});

test("rejects unsafe colors and font stacks", () => {
  const invalidColor = structuredClone(BUILTIN_THEMES[0]);
  invalidColor.id = "invalid-color";
  invalidColor.variants.light.colors.accent = "url(javascript:alert(1))";
  assert.throws(() => validateThemePack(invalidColor), /十六进制颜色/);

  const invalidFont = structuredClone(BUILTIN_THEMES[0]);
  invalidFont.id = "invalid-font";
  invalidFont.variants.dark.typography.uiFont = "url(file:///tmp/font.woff)";
  assert.throws(() => validateThemePack(invalidFont), /安全字体栈/);
});

test("resolves system, light, and dark appearance modes", () => {
  assert.equal(resolveColorScheme("system", false), "light");
  assert.equal(resolveColorScheme("system", true), "dark");
  assert.equal(resolveColorScheme("light", true), "light");
  assert.equal(resolveColorScheme("dark", false), "dark");
});

test("normalizes preferences and migrates legacy theme packs", () => {
  assert.deepEqual(normalizeThemePreference({ mode: "unexpected", themeId: "" }), {
    codeThemeId: undefined,
    mode: "system",
    themeId: "deepcreator"
  });
  assert.deepEqual(normalizeThemePreference({ codeThemeId: "deepseeker", themeId: "deepseeker" }), {
    codeThemeId: "deepcreator",
    mode: "system",
    themeId: "deepcreator"
  });

  const legacy = structuredClone(BUILTIN_THEMES[0]) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 0;
  legacy.readonly = false;
  const variants = legacy.variants as Record<string, Record<string, unknown>>;
  delete variants.light.contrast;
  delete variants.light.typography;
  delete variants.light.translucentSidebar;
  const migrated = validateThemePack(legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.variants.light.contrast, 50);
  assert.equal(migrated.variants.light.translucentSidebar, false);
  assert.match(migrated.variants.light.typography.uiFont, /Alibaba PuHuiTi 3/);
});

test("imports DeepCreator themes as non-destructive custom previews", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-theme-"));
  const file = path.join(directory, "native.json");
  writeFileSync(file, JSON.stringify(BUILTIN_THEMES[1]));
  const imported = importThemeFile(file, BUILTIN_THEMES[0], "light");
  assert.equal(imported.source, "imported");
  assert.equal(imported.readonly, false);
  assert.notEqual(imported.id, BUILTIN_THEMES[1].id);
  assert.equal(imported.variants.dark.code.background, BUILTIN_THEMES[1].variants.dark.code.background);
});

test("imports VS Code JSONC colors, tokens, and relative includes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-vscode-theme-"));
  const nested = path.join(directory, "base");
  mkdirSync(nested);
  writeFileSync(path.join(nested, "base.jsonc"), `{
    // Base editor colors
    "colors": {
      "editor.background": "#101820",
      "editor.foreground": "#F0F4F8",
    },
    "tokenColors": [
      { "scope": "comment", "settings": { "foreground": "#829AB1" } }
    ]
  }`);
  writeFileSync(path.join(nested, "theme.jsonc"), `{
    "name": "Ocean Test",
    "include": "./base.jsonc",
    "colors": {
      "sideBar.background": "#132F3B",
      "focusBorder": "#2BB0ED"
    },
    "tokenColors": [
      { "scope": ["keyword"], "settings": { "foreground": "#FF6B6B" } }
    ]
  }`);

  const imported = importThemeFile(path.join(nested, "theme.jsonc"), BUILTIN_THEMES[0], "dark");
  assert.equal(imported.name, "Ocean Test");
  assert.equal(imported.variants.dark.code.background, "#101820");
  assert.equal(imported.variants.dark.code.comment, "#829AB1");
  assert.equal(imported.variants.dark.code.keyword, "#FF6B6B");
  assert.equal(imported.variants.dark.colors.sidebar, "#132F3B");
  assert.equal(imported.variants.light.colors.background, BUILTIN_THEMES[0].variants.light.colors.background);
});

test("rejects VS Code includes that escape the selected theme directory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-vscode-escape-"));
  writeFileSync(path.join(directory, "outside.json"), "{}");
  const nested = path.join(directory, "nested");
  mkdirSync(nested);
  writeFileSync(path.join(nested, "theme.jsonc"), `{ "include": "../outside.json" }`);
  assert.throws(
    () => importThemeFile(path.join(nested, "theme.jsonc"), BUILTIN_THEMES[0], "light"),
    /不能离开主题目录/
  );
});
