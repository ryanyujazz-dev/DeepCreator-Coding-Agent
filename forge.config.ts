import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

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
