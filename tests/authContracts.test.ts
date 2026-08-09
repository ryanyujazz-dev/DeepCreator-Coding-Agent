import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("keeps user authentication separate from the loopback runtime token", () => {
  const main = readFileSync(path.join(root, "desktop/main.ts"), "utf8");
  const preload = readFileSync(path.join(root, "desktop/preload.ts"), "utf8");
  const manager = readFileSync(path.join(root, "desktop/authManager.ts"), "utf8");
  assert.match(main, /authenticated\(\); return runtime\.connection\(\)/);
  assert.match(main, /onSignedOut: \(\) => runtime\.stop\(\)/);
  assert.match(preload, /desktop:auth:get-state/);
  assert.doesNotMatch(preload, /refreshToken|offlineGrant|accessToken|pollToken/);
  assert.doesNotMatch(manager, /RUNTIME_AUTH_TOKEN/);
});

test("defaults releases to local Profile while keeping GitHub auth explicitly configurable", () => {
  const forge = readFileSync(path.join(root, "forge.config.ts"), "utf8");
  const manager = readFileSync(path.join(root, "desktop/authManager.ts"), "utf8");
  const validator = readFileSync(path.join(root, "scripts/validate-release-auth.mjs"), "utf8");
  assert.match(forge, /authMode = process\.env\.DEEPCREATOR_AUTH_MODE\?\.trim\(\) \|\| "local"/);
  assert.match(forge, /releaseBuild && authMode === "github"/);
  assert.match(forge, /DEEPCREATOR_AUTH_BASE_URL/);
  assert.match(forge, /DEEPCREATOR_AUTH_PUBLIC_JWK/);
  assert.match(forge, /url\.protocol !== "https:"/);
  assert.match(validator, /authMode === "github"/);
  assert.match(manager, /this\.mode === "github" && !app\.isPackaged && __DEEPCREATOR_DEV_AUTH_BYPASS__ === "1"/);
  assert.match(manager, /this\.options\.store\.localProfileId\(\)/);
});

test("does not convert an explicitly rejected cloud session into offline access", () => {
  const source = readFileSync(path.join(root, "desktop/authManager.ts"), "utf8");
  assert.match(source, /error instanceof AuthRequestError/);
  assert.match(source, /error\.status === 401 \|\| error\.status === 403/);
  assert.match(source, /!sessionRejected && await this\.canUseOffline\(\)/);
});

test("scopes local runtime and credentials to the authenticated profile", () => {
  const store = readFileSync(path.join(root, "desktop/store.ts"), "utf8");
  const runtime = readFileSync(path.join(root, "desktop/runtime-host.ts"), "utf8");
  assert.match(store, /"profiles", userId\.toLowerCase\(\)/);
  assert.match(store, /profileMigrationOwner/);
  assert.match(store, /localProfileId/);
  assert.match(store, /randomUUID\(\)/);
  assert.match(store, /migratedProfile && userIdPattern\.test\(migratedProfile\)/);
  assert.match(store, /safeStorage\.encryptString/);
  assert.match(runtime, /this\.store\.activeProfileDirectory\(\)/);
});

test("persists a skippable local Profile setup without exposing it outside Electron Main", () => {
  const contract = readFileSync(path.join(root, "shared/contracts/auth.ts"), "utf8");
  const main = readFileSync(path.join(root, "desktop/main.ts"), "utf8");
  const manager = readFileSync(path.join(root, "desktop/authManager.ts"), "utf8");
  const preload = readFileSync(path.join(root, "desktop/preload.ts"), "utf8");
  const setup = readFileSync(path.join(root, "src/features/auth/LocalProfileSetup.tsx"), "utf8");
  const store = readFileSync(path.join(root, "desktop/store.ts"), "utf8");
  assert.match(contract, /LocalProfileAvatar = "amber" \| "blue" \| "green" \| "slate"/);
  assert.match(contract, /profileSetupRequired\?: boolean/);
  assert.match(main, /desktop:auth:update-local-profile/);
  assert.match(preload, /updateLocalProfile/);
  assert.match(manager, /saveLocalProfile\(input\)/);
  assert.match(store, /displayName\.length > 30/);
  assert.match(store, /localProfileSetupComplete = true/);
  assert.match(store, /localProfileSetupComplete = Boolean\(this\.device\.profileMigrationOwner\)/);
  assert.match(setup, /暂时跳过/);
  assert.match(setup, /不需要手机号或邮箱，不会上传个人资料/);
  assert.doesNotMatch(preload, /localProfileSetupComplete/);
});
