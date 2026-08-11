import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const releaseBuild = /^(?:package|make):/.test(process.env.npm_lifecycle_event || "")
  || process.argv.some((argument) => argument === "package" || argument === "make");
const authMode = process.env.DEEPCREATOR_AUTH_MODE?.trim() || "local";
const appleId = process.env.APPLE_ID?.trim();
const appleIdPassword = process.env.APPLE_ID_PASSWORD?.trim();
const appleKeychain = process.env.APPLE_KEYCHAIN?.trim();
const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const appleTeamId = process.env.APPLE_TEAM_ID?.trim();
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim();
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD?.trim();
const productionMacSigning = Boolean(appleSigningIdentity && appleId && appleIdPassword && appleTeamId);
const productionWindowsSigning = Boolean(windowsCertificateFile && windowsCertificatePassword);
const lifecycleEvent = process.env.npm_lifecycle_event || "";
const targetPlatform = lifecycleEvent.includes(":windows")
  ? "win32"
  : lifecycleEvent.includes(":mac")
    ? "darwin"
    : process.platform;
const appIcon = targetPlatform === "darwin"
  ? "assets/app-icon.icns"
  : targetPlatform === "win32"
    ? "assets/app-icon.ico"
    : "assets/app-icon.png";

if (authMode !== "local" && authMode !== "github") {
  throw new Error("DEEPCREATOR_AUTH_MODE 只支持 local 或 github。");
}

if (releaseBuild && authMode === "github") {
  const baseUrl = process.env.DEEPCREATOR_AUTH_BASE_URL?.trim();
  const publicJwk = process.env.DEEPCREATOR_AUTH_PUBLIC_JWK?.trim();
  if (!baseUrl || !publicJwk) throw new Error("正式打包必须配置 DEEPCREATOR_AUTH_BASE_URL 和 DEEPCREATOR_AUTH_PUBLIC_JWK。");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("正式打包的账号服务地址必须使用 HTTPS。");
  const parsed = JSON.parse(publicJwk) as Record<string, unknown>;
  if (parsed.kty !== "OKP" || parsed.crv !== "Ed25519" || typeof parsed.x !== "string") {
    throw new Error("DEEPCREATOR_AUTH_PUBLIC_JWK 必须是 Ed25519 公钥 JWK。");
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "com.deepcreator.desktop",
    asar: true,
    icon: appIcon,
    // The Vite plugin normally copies only .vite. Main and Runtime Worker dependencies are
    // intentionally externalized, so production node_modules must travel with the app as well.
    ignore: (filePath) => {
      if (!filePath) return false;
      return !filePath.startsWith("/.vite") && !filePath.startsWith("/node_modules");
    },
    prune: true,
    extraResource: [
      "server/infra/migrations",
      "skills"
    ],
    name: "DeepCreator",
    osxNotarize: productionMacSigning ? { appleId: appleId!, appleIdPassword: appleIdPassword!, teamId: appleTeamId! } : undefined,
    osxSign: productionMacSigning
      ? {
          identity: appleSigningIdentity,
          keychain: appleKeychain,
          optionsForFile: () => ({ hardenedRuntime: true })
        }
      : {
          identity: "-",
          identityValidation: false,
          optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
          type: "development"
        }
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin", "win32"]),
    new MakerSquirrel({
      ...(productionWindowsSigning ? {
        certificateFile: windowsCertificateFile,
        certificatePassword: windowsCertificatePassword
      } : {}),
      name: "deepcreator",
      noMsi: true,
      setupExe: "DeepCreator-Setup.exe",
      setupIcon: "assets/app-icon.ico"
    }, ["win32"])
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "desktop/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "desktop/preload.ts", config: "vite.preload.config.ts", target: "preload" },
        { entry: "desktop/runtime-worker.ts", config: "vite.main.config.ts", target: "main" }
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }]
    })
  ]
};

export default config;
