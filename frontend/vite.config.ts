import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    // HMR is disabled so the served bundle stays a plain static build.
    hmr: false,
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://127.0.0.1:4000",
        changeOrigin: true,
      },
      "/v1": {
        target: process.env.VITE_BACKEND_URL || "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_PORT ?? 5173),
  },
});
