import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(root, "src/styles.css"), "utf8");

test("keeps one semantic token source and the licensed HarmonyOS font", () => {
  assert.equal(styles.match(/^:root\s*\{/gm)?.length, 1);
  assert.match(styles, /--font-family-ui:\s*"HarmonyOS Sans SC"/);
  assert.match(styles, /--type-conversation-size:\s*14px/);
  assert.match(styles, /--execution-icon-column:\s*16px/);
  assert.match(styles, /--execution-slot-gap:\s*8px/);

  const font = path.join(root, "src/assets/fonts/HarmonyOS_Sans_SC.ttf");
  const license = path.join(root, "src/assets/fonts/LICENSE-HarmonyOS-Sans.txt");
  assert.equal(existsSync(font), true);
  assert.equal(existsSync(license), true);
  assert.ok(statSync(font).size > 20_000_000);
});

test("binds every execution hierarchy level to shared typography and columns", () => {
  assert.match(styles, /\.tool-step\s*\{[^}]*grid-template-columns:\s*var\(--execution-icon-column\)/s);
  assert.match(styles, /\.operation-call-row[\s\S]*grid-template-columns:\s*var\(--execution-icon-column\)/);
  assert.match(styles, /\.operation-detail-panel\s*>\s*header[\s\S]*font-size:\s*var\(--type-conversation-size\)/);
  assert.match(styles, /\.work-process \.content-step \.markdown-content,[\s\S]*font-family:\s*var\(--font-family-ui\);[\s\S]*font-size:\s*var\(--type-conversation-size\);[\s\S]*line-height:\s*var\(--type-conversation-line-height\)/);
  assert.match(styles, /\.operation-group-expander,[\s\S]*margin-left:\s*0;[\s\S]*padding-left:\s*0;/);
});

test("uses structural gaps for equal execution slot spacing", () => {
  assert.match(styles, /\.work-process\s*\{[^}]*gap:\s*var\(--execution-slot-gap\)/s);
  assert.match(styles, /\.display-segment\s*\{[^}]*gap:\s*var\(--execution-slot-gap\)/s);
  assert.match(styles, /--execution-expanded-gap:\s*calc\(var\(--execution-slot-gap\) \/ 2\)/);
  assert.match(styles, /\.operation-group-details\s*\{[^}]*margin:\s*var\(--execution-expanded-gap\) 0 0;[^}]*gap:\s*var\(--execution-expanded-gap\)/s);
  assert.match(styles, /\.operation-detail-panel\s*\{[^}]*margin-top:\s*var\(--execution-expanded-gap\)/s);
  assert.match(styles, /\.work-process \.work-body,\s*\.work-process \.operation-group\s*\{[^}]*padding-bottom:\s*0/s);
});

test("renders third-level tool details as one shared window", () => {
  assert.match(styles, /\.operation-detail-panel\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid var\(--color-border\);[^}]*background:\s*var\(--color-surface-subtle\)/s);
  assert.match(styles, /\.operation-detail-panel\s*>\s*header\s*\{[^}]*border-bottom:\s*1px solid var\(--color-border\);[^}]*background:\s*var\(--color-surface-subtle\)/s);
  assert.match(styles, /\.operation-detail-body\s*>\s*div\s*\{[^}]*padding-top:\s*0;/s);
  assert.match(styles, /\.operation-detail-text\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent/s);
});

test("anchors the scroll-to-bottom control to the responsive composer center", () => {
  assert.match(styles, /\.scroll-to-bottom-button\s*\{[^}]*bottom:\s*calc\(100% \+ 12px\);[^}]*left:\s*50%/s);
  assert.doesNotMatch(styles, /\.inspector-layout-reserved \.scroll-to-bottom-button/);

  const conversation = readFileSync(path.join(root, "src/components/Conversation.tsx"), "utf8");
  assert.match(conversation, /setComposerPortalTarget\(parent\.querySelector<HTMLElement>\("\.composer-stack"\)\)/);
  assert.match(conversation, /createPortal\([\s\S]*className="scroll-to-bottom-button"[\s\S]*composerPortalTarget/s);
});

test("keeps aggregate failures muted instead of coloring the entire header", () => {
  assert.match(styles, /\.operation-group\.is-failed \.operation-group-icon,[\s\S]*color:\s*var\(--process-muted-color\)/);
  assert.match(styles, /\.operation-group-failure,[\s\S]*color:\s*#a4abad/);

  const renderer = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  assert.match(renderer, /className="operation-group-failure"/);
  assert.match(renderer, /<AggregateSummary aggregate=\{aggregate\}/);
});

test("colors only the failure word in expanded activity rows", () => {
  assert.match(styles, /\.operation-call-row\.is-failed\s*\{[^}]*color:\s*var\(--process-detail-color\)/s);
  assert.match(styles, /\.operation-failure-word\s*\{[^}]*color:\s*#b74b3f/s);

  const renderer = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  assert.match(renderer, /function FailureAwareLabel/);
  assert.match(renderer, /className="operation-failure-word">失败/);
});

test("keeps the sidebar project list compact", () => {
  assert.match(styles, /--type-sidebar-size:\s*14px/);
  assert.match(styles, /\.sidebar-section h2\s*\{[^}]*margin:\s*0 9px 6px/s);
  assert.match(styles, /\.sidebar-section h2\s*\{[^}]*font-size:\s*var\(--type-sidebar-size\)/s);
  assert.match(styles, /\.project-group\s*\{[^}]*margin-bottom:\s*10px;[^}]*gap:\s*1px/s);
  assert.match(styles, /\.project-group\.is-collapsed\s*\{[^}]*margin-bottom:\s*8px/s);
  assert.match(styles, /\.project-title span\s*\{[^}]*font-size:\s*var\(--type-sidebar-size\)/s);
  assert.match(styles, /\.thread-row > span:first-child\s*\{[^}]*font-size:\s*var\(--type-sidebar-size\)/s);
  assert.match(styles, /\.account-strip strong\s*\{[^}]*font-size:\s*var\(--type-sidebar-size\)/s);
  assert.match(styles, /\.sidebar \.project-title\s*\{[^}]*min-height:\s*29px;[^}]*padding:\s*0 9px/s);
  assert.match(styles, /\.sidebar \.thread-row\s*\{[^}]*min-height:\s*29px;[^}]*padding:\s*0 9px 0 24px/s);
});

test("keeps conversation workflow interaction feedback color-only", () => {
  assert.match(styles, /Conversation workflow interactions use color, never a highlight surface/);
  assert.match(styles, /\.run-stream button:hover:not\(:disabled\)[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.run-stream \.ui-pill-button\[aria-expanded="true"\][\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.run-stream \.patch-row:hover[\s\S]*?background:\s*transparent/);
});

test("keeps primary conversation controls visible and aligned", () => {
  assert.match(styles, /\.ui-icon-button\.send-button\s*\{[^}]*background:\s*var\(--color-control-idle\)/s);
  assert.match(styles, /\.ui-icon-button\.send-button:disabled\s*\{[^}]*opacity:\s*1/s);
  assert.match(styles, /\.run-status-pill\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent/s);
  assert.match(styles, /\.run-stream\s*\{[^}]*border-top:\s*0;/s);
  assert.match(styles, /\.run-status-pill\[aria-expanded="true"\]\s*\{[^}]*color:\s*var\(--color-text-muted\)/s);

  const conversation = readFileSync(path.join(root, "src/components/Conversation.tsx"), "utf8");
  assert.match(conversation, /const \[composerPortalTarget, setComposerPortalTarget\]/);
  assert.doesNotMatch(conversation, /composerCenterX|composerRect\.left - mainRect\.left/);
});

test("provides the shared interaction primitives required by the design guide", () => {
  const primitives = readFileSync(path.join(root, "src/shared-ui/ControlPrimitives.tsx"), "utf8");
  for (const name of ["IconButton", "PillButton", "RowAction", "FloatingSurface", "DisclosureRow"]) {
    assert.match(primitives, new RegExp(`export (?:const|function) ${name}`));
  }
  assert.equal(existsSync(path.join(root, "src/components/ConfirmationDialog.tsx")), true);
});

test("routes the renderer, code views, and settings workspace through the shared theme system", () => {
  const main = readFileSync(path.join(root, "src/main.tsx"), "utf8");
  const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const provider = readFileSync(path.join(root, "src/theme/ThemeProvider.tsx"), "utf8");
  const monaco = readFileSync(path.join(root, "src/components/CodeEditorSurface.tsx"), "utf8");
  const diffEnvironment = readFileSync(path.join(root, "src/editor/diffEnvironment.ts"), "utf8");
  const markdown = readFileSync(path.join(root, "src/components/MarkdownContent.tsx"), "utf8");
  const mermaid = readFileSync(path.join(root, "src/components/MermaidBlock.tsx"), "utf8");

  assert.match(main, /<ThemeProvider>/);
  assert.match(app, /<SettingsWorkspace/);
  assert.match(provider, /root\.dataset\.theme = activeTheme\.id/);
  assert.match(provider, /previewTheme/);
  assert.match(provider, /"--shadow-faint-color"/);
  assert.match(provider, /"--shadow-strong-color"/);
  assert.match(provider, /"--shadow-canvas-soft-color"/);
  assert.match(styles, /--shadow-canvas:\s*0 0 34px var\(--shadow-canvas-soft-color\)/);
  assert.doesNotMatch(styles, /--shadow-canvas-edge|box-shadow:\s*inset[^;]*var\(--shadow-canvas/);
  assert.doesNotMatch(styles, /box-shadow:\s*-1px -1px 0 var\(--app-border\)/);
  assert.match(styles, /\.app-frame\s*\{[^}]*background-color:\s*var\(--app-chrome\)/s);
  assert.match(styles, /\.app-menubar,\s*\.app-shell\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /--shadow-floating:\s*0 18px 46px var\(--shadow-soft-color\)/);
  assert.match(provider, /const codeTheme = activeTheme/);
  assert.match(monaco, /prepareMonacoTheme/);
  assert.match(monaco, /<PatchDiff/);
  assert.match(monaco, /diffStyle:\s*"unified"/);
  assert.match(monaco, /diffIndicators:\s*"bars"/);
  assert.match(monaco, /lineDiffType:\s*"none"/);
  assert.match(diffEnvironment, /"--diffs-bg-addition-number-override":\s*code\.added/);
  assert.match(diffEnvironment, /"--diffs-bg-addition-override":\s*code\.addedGutter/);
  assert.match(diffEnvironment, /"--diffs-bg-deletion-number-override":\s*code\.removed/);
  assert.match(diffEnvironment, /"--diffs-bg-deletion-override":\s*code\.removedGutter/);
  assert.match(markdown, /useOptionalTheme\(\)\?\.prismTheme/);
  assert.match(mermaid, /themeVariables:\s*\{/);
});

test("captures settings input values before updating the theme draft", () => {
  const appearance = readFileSync(path.join(root, "src/components/settings/AppearanceSettings.tsx"), "utf8");
  assert.match(appearance, /const name = event\.currentTarget\.value;[\s\S]*next\.name = name;/);
  assert.match(appearance, /const contrast = Number\(event\.currentTarget\.value\);[\s\S]*contrast = contrast;/);
  assert.doesNotMatch(appearance, /mutateDraft\(\(next\) => \{[^}]*event\.(?:currentTarget|target)\.value/s);
});

test("does not grow the legacy raw-color surface outside the theme catalog", () => {
  const componentFiles = [
    path.join(root, "src/styles.css"),
    ...[
      "ActivityView.tsx",
      "ActivityGroupRenderer.tsx",
      "AppTopbar.tsx",
      "ChangePanel.tsx",
      "Composer.tsx",
      "Conversation.tsx",
      "Inspector.tsx",
      "SurfacePane.tsx"
    ].map((file) => path.join(root, "src/components", file))
  ];
  const rawColorCount = componentFiles.reduce((total, file) => {
    const source = readFileSync(file, "utf8");
    return total + (source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)?.length ?? 0);
  }, 0);

  // This is a migration ceiling for the legacy stylesheet, not a target.
  assert.ok(rawColorCount <= 712, `raw color ceiling exceeded: ${rawColorCount}`);
});
