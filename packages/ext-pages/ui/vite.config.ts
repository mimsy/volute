import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [svelte()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:1618",
      "/pages": "http://localhost:1618",
      "/ext-theme.css": "http://localhost:1618",
    },
  },
});
