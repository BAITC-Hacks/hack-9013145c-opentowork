import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В dev обращения к /api проксируются на бэкенд, в проде тем же путём их
// проксирует nginx. Благодаря этому фронтенд везде ходит по относительному
// пути и не нуждается в baseURL, зашитом на этапе сборки.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_URL || "http://localhost:8000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
