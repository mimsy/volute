import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.ts", "src/daemon.ts"],
    format: ["esm"],
    outDir: "dist",
    splitting: true,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/connectors/discord.ts"],
    format: ["esm"],
    outDir: "dist/connectors",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
