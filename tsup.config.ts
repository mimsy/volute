import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      daemon: "src/daemon.ts",
      "connectors/discord-bridge": "src/connectors/discord-bridge.ts",
      "connectors/slack-bridge": "src/connectors/slack-bridge.ts",
      "connectors/telegram-bridge": "src/connectors/telegram-bridge.ts",
    },
    format: ["esm"],
    outDir: "dist",
    splitting: true,
    clean: true,
    external: ["libsql"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { api: "src/api.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: { only: true },
  },
]);
