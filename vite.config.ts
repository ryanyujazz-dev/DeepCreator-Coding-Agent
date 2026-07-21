import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    },
    strictPort: false
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("node_modules/mermaid") ? "mermaid" : undefined)
      }
    }
  }
});
