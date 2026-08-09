import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig({
  define: {
    __DEEPCREATOR_AUTH_BASE_URL__: JSON.stringify(process.env.DEEPCREATOR_AUTH_BASE_URL?.trim() || ""),
    __DEEPCREATOR_AUTH_MODE__: JSON.stringify(process.env.DEEPCREATOR_AUTH_MODE?.trim() || "local"),
    __DEEPCREATOR_AUTH_PUBLIC_JWK__: JSON.stringify(process.env.DEEPCREATOR_AUTH_PUBLIC_JWK?.trim() || ""),
    __DEEPCREATOR_DEV_AUTH_BYPASS__: JSON.stringify(process.env.DEEPCREATOR_DEV_AUTH_BYPASS?.trim() || ""),
    __DEEPCREATOR_UPDATE_HOST__: JSON.stringify(process.env.DEEPCREATOR_UPDATE_HOST?.trim() || "https://update.electronjs.org"),
    __DEEPCREATOR_UPDATE_REPOSITORY__: JSON.stringify(process.env.DEEPCREATOR_UPDATE_REPOSITORY?.trim() || "ryanyujazz-dev/DeepCreator-Coding-Agent")
  },
  build: {
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        ...Object.keys(packageJson.dependencies)
      ]
    }
  }
});
