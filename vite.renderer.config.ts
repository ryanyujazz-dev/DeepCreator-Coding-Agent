import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false },
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
