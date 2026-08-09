import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const releaseBuild = /^(?:package|make):/.test(process.env.npm_lifecycle_event || "")
  || process.argv.some((argument) => argument === "package" || argument === "make");
const authMode = process.env.DEEPCREATOR_AUTH_MODE?.trim() || "local";

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
    asar: true,
    extraResource: [
      "server/infra/migrations",
      "skills"
    ],
    name: "DeepCreator",
    osxSign: {
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: "none"
      }),
      type: "development"
    }
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin", "win32"])],
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
