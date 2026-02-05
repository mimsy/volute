import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "../../../dist/web-assets",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:4200",
    },
  },
});
