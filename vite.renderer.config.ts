import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("node_modules/mermaid") ? "mermaid" : undefined)
      }
    }
  }
});
