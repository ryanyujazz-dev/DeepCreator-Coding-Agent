import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      ignored: ["**/.eval-worktrees/**", "**/evals/runs/**"]
    },
    proxy: {
      "/api": "http://127.0.0.1:8787"
    },
    strictPort: false
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/mermaid")) return "mermaid";
          if (id.includes("node_modules/lottie-react") || id.includes("node_modules/lottie-web")) return "lottie";
          return undefined;
        }
      }
    }
  }
});
