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
  assert.match(styles, /--type-conversation-size:\s*13px/);
  assert.match(styles, /--execution-icon-column:\s*16px/);

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
  assert.match(styles, /\.operation-group-expander,[\s\S]*margin-left:\s*0;[\s\S]*padding-left:\s*0;/);
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
  assert.match(conversation, /composerCenterX/);
  assert.match(conversation, /composerRect\.left - mainRect\.left \+ composerRect\.width \/ 2/);
});

test("provides the shared interaction primitives required by the design guide", () => {
  const primitives = readFileSync(path.join(root, "src/components/ui/ControlPrimitives.tsx"), "utf8");
  for (const name of ["IconButton", "PillButton", "RowAction", "FloatingSurface", "DisclosureRow"]) {
    assert.match(primitives, new RegExp(`export (?:const|function) ${name}`));
  }
  assert.equal(existsSync(path.join(root, "src/components/ConfirmationDialog.tsx")), true);
});
