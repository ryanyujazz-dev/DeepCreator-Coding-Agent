import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig({
  define: {
    __DEEPCREATOR_AUTH_BASE_URL__: JSON.stringify(process.env.DEEPCREATOR_AUTH_BASE_URL?.trim() || ""),
    __DEEPCREATOR_AUTH_MODE__: JSON.stringify(process.env.DEEPCREATOR_AUTH_MODE?.trim() || "local"),
    __DEEPCREATOR_AUTH_PUBLIC_JWK__: JSON.stringify(process.env.DEEPCREATOR_AUTH_PUBLIC_JWK?.trim() || ""),
    __DEEPCREATOR_DEV_AUTH_BYPASS__: JSON.stringify(process.env.DEEPCREATOR_DEV_AUTH_BYPASS?.trim() || "")
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
