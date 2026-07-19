import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig({
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
