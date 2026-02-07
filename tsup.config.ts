import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "src/daemon.ts",
    "connectors/discord": "src/connectors/discord.ts",
  },
  format: ["esm"],
  outDir: "dist",
  splitting: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
