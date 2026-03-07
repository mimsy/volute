import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      daemon: "src/daemon.ts",
      "connectors/discord": "src/connectors/discord.ts",
      "connectors/slack": "src/connectors/slack.ts",
      "connectors/telegram": "src/connectors/telegram.ts",
    },
    format: ["esm"],
    outDir: "dist",
    splitting: true,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { api: "src/api.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: { only: true },
  },
]);
