import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(root, "src/styles.css"), "utf8");
const applicationSurfaces = readFileSync(path.join(root, "src/styles/features/application-surfaces.css"), "utf8");
const authStyles = readFileSync(path.join(root, "src/styles/features/auth.css"), "utf8");
const composerBarStyles = readFileSync(path.join(root, "src/styles/features/composer-bar.css"), "utf8");
const followUpStyles = readFileSync(path.join(root, "src/styles/features/follow-ups.css"), "utf8");
const updateStyles = readFileSync(path.join(root, "src/styles/features/updates.css"), "utf8");
const composer = readFileSync(path.join(root, "src/components/Composer.tsx"), "utf8");
const projectContextSelector = readFileSync(path.join(root, "src/components/ProjectContextSelector.tsx"), "utf8");

test("keeps one semantic token source and the licensed HarmonyOS font", () => {
  assert.equal(styles.match(/^:root\s*\{/gm)?.length, 1);
  assert.match(styles, /--font-family-ui:\s*"HarmonyOS Sans SC"/);
  assert.match(styles, /--type-conversation-size:\s*14px/);
  assert.match(styles, /--execution-icon-column:\s*16px/);
  assert.match(styles, /--color-execution-muted:\s*#8e969b/);
  assert.match(styles, /--execution-slot-gap:\s*12px/);

  const font = path.join(root, "src/assets/fonts/HarmonyOS_Sans_SC.ttf");
  const license = path.join(root, "src/assets/fonts/LICENSE-HarmonyOS-Sans.txt");
  assert.equal(existsSync(font), true);
  assert.equal(existsSync(license), true);
  assert.ok(statSync(font).size > 20_000_000);
});

test("keeps settings development-only and centers the sidebar Profile avatar", () => {
  const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const sidebar = readFileSync(path.join(root, "src/components/SessionSidebar.tsx"), "utf8");
  assert.match(app, /const DeveloperSettingsWorkspace = import\.meta\.env\.DEV/);
  assert.match(app, /if \(DeveloperSettingsWorkspace\) setWorkspaceView\("settings"\)/);
  assert.match(app, /else setQuickSettingsOpen\(true\)/);
  assert.match(app, /<SettingsDialog authState=\{authState\}/);
  assert.doesNotMatch(sidebar, /CircleHelp/);
  assert.match(authStyles, /\.account-strip \.profile-avatar\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*line-height:\s*1;[^}]*text-align:\s*center;/s);
});

test("reserves the native traffic-light area only on macOS", () => {
  const contract = readFileSync(path.join(root, "shared/contracts/desktop.ts"), "utf8");
  const desktopMain = readFileSync(path.join(root, "desktop/main.ts"), "utf8");
  const preload = readFileSync(path.join(root, "desktop/preload.ts"), "utf8");
  const topbar = readFileSync(path.join(root, "src/components/AppTopbar.tsx"), "utf8");
  assert.match(contract, /DesktopPlatform = "darwin" \| "linux" \| "win32"/);
  assert.match(preload, /platform: process\.platform === "darwin" \|\| process\.platform === "win32" \? process\.platform : "linux"/);
  assert.match(topbar, /data-platform=\{platform\}/);
  assert.match(topbar, /data-window-controls=\{trafficLightsVisible \? "visible" : "hidden"\}/);
  assert.match(topbar, /desktop\.windowControls\.onState/);
  assert.match(topbar, /desktop\.windowControls\.getState\(\)/);
  assert.match(styles, /--layout-macos-window-controls-inset:\s*80px/);
  assert.match(applicationSurfaces, /\.app-menubar\[data-platform="darwin"\]\[data-window-controls="visible"\]\s*\{[^}]*padding-left:\s*var\(--layout-macos-window-controls-inset\)/s);
  assert.doesNotMatch(applicationSurfaces, /\.app-menubar\[data-platform="win32"\]/);
  assert.match(desktopMain, /const TITLEBAR_HEIGHT = 42/);
  assert.match(desktopMain, /y: \(TITLEBAR_HEIGHT - MACOS_TRAFFIC_LIGHT_DIAMETER\) \/ 2/);
  assert.match(desktopMain, /titleBarStyle: "hiddenInset" as const,\s*trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION/s);
  assert.match(desktopMain, /window\.on\("enter-full-screen", publishWindowControlsState\)/);
  assert.match(desktopMain, /window\.on\("leave-full-screen", publishWindowControlsState\)/);
});

test("keeps application updates beside settings and inside the shared design system", () => {
  const sidebar = readFileSync(path.join(root, "src/components/SessionSidebar.tsx"), "utf8");
  const updateControl = readFileSync(path.join(root, "src/features/updates/AppUpdateControl.tsx"), "utf8");
  assert.match(sidebar, /<AppUpdateControl \/>\s*\{onSettings && <IconButton label="打开设置"/);
  assert.match(updateControl, /desktop\.updates\.onState/);
  assert.match(updateControl, /desktop\.updates\.check\(\)/);
  assert.match(updateControl, /desktop\.updates\.install\(\)/);
  assert.match(updateControl, /aria-haspopup="dialog"/);
  assert.match(updateStyles, /\.app-update-popover\s*\{[^}]*position:\s*fixed;[^}]*width:\s*min\(328px/s);
  assert.match(updateStyles, /\.app-update-primary\s*\{[^}]*background:\s*var\(--theme-blue\)/s);
  assert.doesNotMatch(updateStyles, /#[0-9a-f]{3,8}|rgba?\(/i);
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
  assert.match(styles, /--execution-expanded-gap:\s*var\(--space-1\)/);
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
  assert.match(styles, /\.scroll-to-bottom-button\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-surface-elevated\) 94%, transparent\);[^}]*color:\s*var\(--color-text-muted\)/s);
  assert.doesNotMatch(styles, /\.scroll-to-bottom-button\s*\{[^}]*background:\s*#fff(?:fff)?/s);
  assert.doesNotMatch(styles, /\.inspector-layout-reserved \.scroll-to-bottom-button/);

  const conversation = readFileSync(path.join(root, "src/components/Conversation.tsx"), "utf8");
  assert.match(conversation, /setComposerPortalTarget\(parent\.querySelector<HTMLElement>\("\.composer-stack"\)\)/);
  assert.match(conversation, /createPortal\([\s\S]*className="scroll-to-bottom-button"[\s\S]*composerPortalTarget/s);
});

test("aligns the project context cap bottom to the composer centerline with a four-pixel lift", () => {
  assert.match(composerBarStyles, /\.composer-stack\.has-project-context\s*\{[^}]*--composer-bar-radius:\s*26px/s);
  assert.match(composerBarStyles, /\.composer-stack\.has-project-context > \.project-context-shelf\s*\{[^}]*height:\s*calc\(2 \* var\(--composer-bar-radius\) \+ var\(--space-1\)\);[^}]*margin:\s*0 0 calc\(0px - var\(--composer-bar-radius\)\);[^}]*padding:\s*0 20px var\(--composer-bar-radius\);[^}]*border-radius:\s*var\(--composer-bar-radius\) var\(--composer-bar-radius\) 0 0/s);
  assert.match(composerBarStyles, /\.project-context-shelf > \.project-context-trigger\s*\{[^}]*height:\s*22px;[^}]*padding:\s*var\(--space-0-5\) var\(--space-1\);[^}]*gap:\s*var\(--space-1-5\)/s);
  assert.match(composerBarStyles, /\.project-context-trigger > span\s*\{[^}]*font-size:\s*var\(--type-meta-size\);[^}]*line-height:\s*var\(--type-meta-line-height\)/s);
  assert.match(composerBarStyles, /\.project-context-trigger > svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px/s);
});

test("gives every composer popover one shared surface and keeps the model menu on canvas", () => {
  assert.match(projectContextSelector, /className="composer-popover project-context-popover"/);
  assert.match(projectContextSelector, /selection\.kind === "project" && \(\s*<label className="project-context-search">/s);
  assert.match(composer, /className="composer-popover composer-menu (?:add|permission|branch|model)-menu"/);
  assert.match(composerBarStyles, /\.composer-stack \.composer-popover\.ui-floating-surface\s*\{[^}]*bottom:\s*calc\(100% \+ 10px\);[^}]*padding:\s*6px;[^}]*border-radius:\s*var\(--radius-surface\);[^}]*box-shadow:\s*var\(--shadow-floating\)/s);
  assert.match(composerBarStyles, /\.composer-stack \.model-menu\s*\{[^}]*right:\s*0;[^}]*left:\s*auto/s);
});

test("floats the composer and reserves its bottom offset plus 60px in the conversation flow", () => {
  assert.match(followUpStyles, /\.conversation-main > \.composer-stack\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*18px/s);
  assert.match(followUpStyles, /\.queued-follow-ups\s*\{[^}]*background:\s*color-mix/s);
  const conversation = readFileSync(path.join(root, "src/components/Conversation.tsx"), "utf8");
  assert.match(conversation, /setComposerBottomOffset\(portalTarget\.clientHeight - composer\.offsetTop\)/);
  assert.match(conversation, /conversation-column-bottom-spacer" style=\{\{ height: `\$\{composerBottomOffset \+ 60\}px` \}\}/);
});

test("floats runtime errors at the centered top of the conversation flow", () => {
  const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  assert.match(app, /<Conversation[\s\S]*className="conversation-error-overlay"[\s\S]*className=\{`composer-stack/s);
  assert.doesNotMatch(app, /className="composer-error"/);
  assert.match(followUpStyles, /\.conversation-error-overlay\s*\{[^}]*position:\s*absolute;[^}]*top:\s*70px;[^}]*right:\s*0;[^}]*left:\s*0;[^}]*align-items:\s*center/s);
  assert.match(followUpStyles, /\.conversation-error-toast\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-surface-elevated\) 94%, transparent\);[^}]*color:\s*var\(--color-danger\)/s);
});

test("keeps aggregate failures muted instead of coloring the entire header", () => {
  assert.match(styles, /\.operation-group\.is-failed \.operation-group-icon,[\s\S]*color:\s*var\(--process-muted-color\)/);
  assert.match(styles, /\.operation-group-failure,[\s\S]*color:\s*var\(--process-muted-color\)/);

  const renderer = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  assert.match(renderer, /className="operation-group-failure"/);
  assert.match(renderer, /<AggregateSummary active=\{headlineActive\} aggregate=\{aggregate\}/);
});

test("uses semantic aggregate icons and keeps the current aggregate active through model reasoning", () => {
  const renderer = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  const segmentRenderer = readFileSync(path.join(root, "src/components/DisplaySegmentRenderer.tsx"), "utf8");
  const timeline = readFileSync(path.join(root, "src/components/RunTimeline.tsx"), "utf8");
  const workingGlowMotion = readFileSync(path.join(root, "src/workingGlowMotion.ts"), "utf8");
  assert.match(styles, /\.activity-aggregate-headline\s*\{[^}]*color:\s*var\(--process-muted-color\)/s);
  assert.match(styles, /\.activity-aggregate-headline\s*\{[^}]*font-weight:\s*inherit/s);
  assert.match(styles, /\.activity-aggregate \.operation-group-summary\[aria-expanded="true"\] \.operation-group-action \*[\s\S]*color:\s*var\(--process-muted-color\)/);
  assert.match(styles, /\.activity-aggregate \.operation-group-summary:hover \.operation-group-action \*[\s\S]*color:\s*var\(--color-text\) !important/s);
  assert.match(styles, /The execution flow uses one neutral gray;[\s\S]*\.work-process \.operation-detail-chevron,[\s\S]*color:\s*var\(--process-muted-color\)/);
  assert.match(renderer, /aggregateIconByHeadline:\s*Record<AggregateHeadlineKind/);
  assert.match(renderer, /browse:\s*FolderTree/);
  assert.match(renderer, /modify:\s*PencilLine/);
  assert.match(renderer, /execute:\s*TerminalSquare/);
  assert.match(renderer, /start_database:\s*Database/);
  assert.match(renderer, /deploy:\s*Rocket/);
  assert.match(renderer, /headlineActive = active \|\| aggregate\.status === "running"/);
  assert.match(renderer, /active \? "working-glow" : ""/);
  assert.match(segmentRenderer, /slotActive = slot\.logicalState === "active" \|\| continuationActive/);
  assert.match(segmentRenderer, /slotActive \? "working-glow" : ""/);
  assert.doesNotMatch(segmentRenderer, /isThinking \? "purpose-sweep" : "working-glow"/);
  assert.match(styles, /\.working-glow,\s*\.purpose-sweep\s*\{[^}]*--working-sweep-width:\s*50px;[^}]*--working-sweep-duration:\s*1\.5s/s);
  assert.match(styles, /--color-execution-highlight:\s*#ffffff/);
  assert.match(styles, /var\(--process-muted-color, var\(--color-execution-muted\)\) 0%,\s*var\(--color-execution-highlight\) 50%,\s*var\(--process-muted-color, var\(--color-execution-muted\)\) 100%/s);
  assert.match(styles, /background-repeat:\s*no-repeat, no-repeat;[\s\S]*background-size:\s*var\(--working-sweep-width\) 100%, 100% 100%/);
  assert.match(workingGlowMotion, /WORKING_SWEEP_BEAT_MS = 1_500/);
  assert.match(workingGlowMotion, /WORKING_SWEEP_WIDTH_PX = 50/);
  assert.match(workingGlowMotion, /animation\.currentTime = timelineTime % metrics\.periodMs/);
  assert.doesNotMatch(styles, /@keyframes working-light-sweep/);
  assert.doesNotMatch(styles, /background-position:\s*110% 50%/);
  assert.doesNotMatch(styles, /purpose-text-sweep/);
  assert.match(timeline, /activeDisplaySegmentId = run\.status === "running"/);
  assert.match(timeline, /continuationActive=\{entry\.entryId === activeDisplaySegmentId\}/);
  assert.doesNotMatch(renderer, /aggregate\.status === "failed" \? <CircleAlert/);
});

test("colors only the failure word in expanded activity rows", () => {
  assert.match(styles, /\.operation-call-row\.is-failed\s*\{[^}]*color:\s*var\(--process-detail-color\)/s);
  assert.match(styles, /\.operation-failure-word\s*\{[^}]*color:\s*var\(--color-danger\)/s);

  const renderer = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  assert.match(renderer, /function FailureAwareLabel/);
  assert.match(renderer, /className="operation-failure-word">失败/);
  assert.match(renderer, /<button[\s\S]*?\{fileDisplayName\(target\)\}[\s\S]*?memberOutcomeLabel\(activity\)/);
});

test("uses semantic dark-mode surfaces and unified expanded-row hover colors", () => {
  assert.match(styles, /\.activity-output\s*\{[^}]*background:\s*var\(--color-surface-subtle\);[^}]*color:\s*var\(--color-text-muted\);[^}]*font-family:\s*var\(--font-family-code\)/s);
  assert.match(styles, /\.composer-hud-primary\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-surface-elevated\) 94%, transparent\)/s);
  assert.doesNotMatch(styles, /\.composer-hud-primary\s*\{[^}]*background:\s*rgba\(255, 255, 255/s);
  assert.match(styles, /\.operation-call-row:hover \.operation-file-reference,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(styles, /\.work-process \.operation-call-row:hover > span:first-child,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(styles, /\.work-process \.operation-file-summary:hover \.operation-file-summary-icon,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(styles, /\.operation-call-row,[\s\S]*\.operation-call-row\.is-expandable\s*\{[^}]*grid-template-columns:\s*var\(--execution-icon-column\) minmax\(0, auto\) 14px/s);
  assert.doesNotMatch(styles, /button\.operation-call-row:hover/);
});

test("themes sidebar overlays and runtime environment descendants", () => {
  assert.match(styles, /Dark counterparts for audited legacy light baselines/);
  assert.match(styles, /\.sidebar-hover-card header strong,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(styles, /\.sidebar-hover-card > div,[\s\S]*color:\s*var\(--color-text-secondary\)/);
  assert.match(styles, /\.sidebar-hover-card header > svg:last-child,[\s\S]*color:\s*var\(--color-text-muted\)/);
  assert.match(styles, /\.environment-section > header,[\s\S]*\.environment-plan-document small\s*\{[^}]*color:\s*var\(--color-text-muted\)/s);
  assert.match(styles, /\.environment-row:hover\s*\{[^}]*background:\s*var\(--color-hover\);[^}]*color:\s*var\(--color-text\)/s);
  assert.doesNotMatch(styles, /(?<!data-color-scheme="dark"\] )\.sidebar-hover-card header strong,[\s\S]{0,500}color:\s*var\(--color-text\)/);
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
  assert.match(styles, /\.run-status-pill\s*\{[^}]*color:\s*var\(--color-execution-muted\)/s);
  assert.match(styles, /\.run-status-pill\[aria-expanded="true"\]\s*\{[^}]*color:\s*var\(--color-execution-muted\)/s);
  assert.match(styles, /\.run-status-pill:hover:not\(:disabled\),[\s\S]*color:\s*var\(--color-text\)/s);

  const conversation = readFileSync(path.join(root, "src/components/Conversation.tsx"), "utf8");
  assert.match(conversation, /const \[composerPortalTarget, setComposerPortalTarget\]/);
  assert.doesNotMatch(conversation, /composerCenterX|composerRect\.left - mainRect\.left/);
});

test("uses one composer action for stopping or sending a queued follow-up", () => {
  const composer = readFileSync(path.join(root, "src/components/Composer.tsx"), "utf8");
  assert.match(composer, /isRunning && !draft\.trim\(\) \? \(/);
  assert.match(composer, /label=\{isRunning \? "加入队列" : "发送"\}/);
  assert.doesNotMatch(composer, /className="send-button queue-button has-draft"/);
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
  assert.match(app, /<DeveloperSettingsWorkspace/);
  assert.match(provider, /root\.dataset\.theme = activeTheme\.id/);
  assert.match(provider, /previewTheme/);
  assert.match(provider, /"--shadow-faint-color"/);
  assert.match(provider, /"--shadow-strong-color"/);
  assert.match(provider, /"--shadow-canvas-soft-color"/);
  assert.match(provider, /"--color-execution-muted": executionMutedColor\(variant\)/);
  assert.match(provider, /"--color-on-accent": contrastingThemeText\(colors\.accent, variant\)/);
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

test("keeps task-scoped Skills visible and refreshes them when settings opens", () => {
  const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const workspace = readFileSync(path.join(root, "src/components/settings/SettingsWorkspace.tsx"), "utf8");
  const skills = readFileSync(path.join(root, "src/components/settings/SkillsSettings.tsx"), "utf8");
  assert.match(app, /currentProjectRoot=\{session\?\.projectRoot\}/);
  assert.match(app, /currentWorkspaceKind=\{session\?\.workspaceKind\}/);
  assert.match(workspace, /<SkillsSettings active=\{visible\}/);
  assert.match(skills, /if \(active\) void load\(\)/);
  assert.match(skills, /workspaceKind === "scratch" \? "当前临时任务" : "当前项目"/);
});

test("keeps the final theme-aware interface mapping free of light-only text colors", () => {
  const marker = "/* Theme-aware overrides for legacy light-only declarations. */";
  const themeAwareOverrides = styles.slice(styles.indexOf(marker));
  assert.ok(themeAwareOverrides.startsWith(marker));
  assert.doesNotMatch(themeAwareOverrides, /(?:^|[;{])\s*color:\s*(?:#[0-9a-fA-F]|rgba?\()/m);
  assert.doesNotMatch(themeAwareOverrides, /background-color:\s*(?:#[0-9a-fA-F]|rgba?\()/);
});

test("captures settings input values before updating the theme draft", () => {
  const appearance = readFileSync(path.join(root, "src/components/settings/AppearanceSettings.tsx"), "utf8");
  assert.match(appearance, /const name = event\.currentTarget\.value;[\s\S]*next\.name = name;/);
  assert.match(appearance, /const contrast = Number\(event\.currentTarget\.value\);[\s\S]*contrast = contrast;/);
  assert.doesNotMatch(appearance, /mutateDraft\(\(next\) => \{[^}]*event\.(?:currentTarget|target)\.value/s);
});

test("keeps raw colors out of business UI components", () => {
  const componentRoot = path.join(root, "src/components");
  const collect = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? collect(path.join(directory, entry.name))
      : entry.name.endsWith(".tsx") ? [path.join(directory, entry.name)] : []);
  const intentionalPreview = path.join(componentRoot, "settings/AppearanceSettings.tsx");
  const rawColor = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;

  for (const file of [
    ...collect(componentRoot),
    ...collect(path.join(root, "src/shared-ui"))
  ]) {
    if (file === intentionalPreview) continue;
    const matches = readFileSync(file, "utf8").match(rawColor) ?? [];
    assert.deepEqual(matches, [], `${path.relative(root, file)} contains raw UI colors: ${matches.join(", ")}`);
  }

  const appearance = readFileSync(intentionalPreview, "utf8");
  assert.deepEqual(
    appearance.match(rawColor),
    ["#2563eb", "#0ea5e9", "#000000", "#20272A", "#FFFFFF"],
    "AppearanceSettings may only keep its documented theme-data previews and dynamic contrast pair"
  );
});

test("keeps the audited dark UI counterpart layer semantic", () => {
  const marker = "/* Dark counterparts for audited legacy light baselines. */";
  const endMarker = "html[data-color-scheme=\"dark\"] .account-strip::before";
  const start = styles.indexOf(marker);
  const end = styles.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  const auditLayer = styles.slice(start, end);
  assert.doesNotMatch(auditLayer, /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-color)?):\s*(?:#[0-9a-fA-F]|rgba?\()/m);
  assert.match(auditLayer, /\.permission-menu/);
  assert.match(auditLayer, /\.context-inspector-popover/);
  assert.match(auditLayer, /\.settings-dialog/);
  assert.match(auditLayer, /\.approval-dialog/);
  assert.match(auditLayer, /\.inline-plan-card/);
  assert.match(auditLayer, /\.plan-surface/);
});

test("does not expand the quarantined legacy light-color baseline", () => {
  const legacyMarker = "/* Theme-aware overrides for legacy light-only declarations. */";
  const legacySection = styles.slice(0, styles.indexOf(legacyMarker));
  const rawColors = legacySection.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
  assert.ok(rawColors.length <= 628, `legacy light-color baseline grew to ${rawColors.length}`);
});

test("keeps dark hover, focus, selected, and context-meter states semantic", () => {
  const marker = "/* Audited dark interaction states.";
  const interactionStates = applicationSurfaces.slice(applicationSurfaces.indexOf(marker));
  assert.ok(interactionStates.startsWith(marker));
  assert.doesNotMatch(
    interactionStates,
    /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-color)?|outline-color|box-shadow):\s*(?:#[0-9a-fA-F]|rgba?\()/m
  );
  assert.match(interactionStates, /:is\(:hover, :focus-visible\) :is\(svg, span, strong, small\)\s*\{[^}]*color:\s*inherit/s);
  assert.match(interactionStates, /\.run-stream :is\(button, \.patch-row\):is\(:hover, :focus-visible, \[aria-expanded="true"\]\)\s*\{[^}]*background:\s*transparent/s);
  assert.match(interactionStates, /\.context-meter-ring\s*\{[^}]*conic-gradient\([^}]*var\(--color-text-muted\)[^}]*var\(--color-surface-subtle\)/s);
  assert.match(interactionStates, /\.context-meter-ring::after\s*\{[^}]*background:\s*var\(--color-surface-elevated\)/s);
  assert.match(interactionStates, /\.context-meter:is\(:hover, :focus-visible, :focus-within\) \.context-meter-ring\s*\{[^}]*var\(--theme-blue\)/s);
  assert.match(interactionStates, /\.project-title-shell:is\(:hover, :has\(:focus-visible\)\)[\s\S]*\.project-title span,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(interactionStates, /\.thread-row-shell:is\(:hover, :has\(:focus-visible\)\)[\s\S]*\.thread-row time,[\s\S]*color:\s*var\(--color-text\)/);
  assert.match(interactionStates, /\.project-context-trigger:hover,[\s\S]*\.ui-pill-button\[aria-expanded="true"\],[\s\S]*:is\(svg, span, strong, small\)\s*\{[^}]*color:\s*inherit/s);
});
