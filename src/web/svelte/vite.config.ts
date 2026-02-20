import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [svelte()],
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
