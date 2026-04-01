import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      daemon: "packages/daemon/src/daemon.ts",
      "connectors/discord-bridge": "packages/daemon/src/lib/bridges/discord-bridge.ts",
      "connectors/slack-bridge": "packages/daemon/src/lib/bridges/slack-bridge.ts",
      "connectors/telegram-bridge": "packages/daemon/src/lib/bridges/telegram-bridge.ts",
    },
    format: ["esm"],
    outDir: "dist",
    splitting: true,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    external: [
      "libsql",
      "sharp",
      "@mariozechner/pi-ai",
      "@mariozechner/pi-coding-agent",
      "@anthropic-ai/claude-agent-sdk",
    ],
  },
  {
    entry: { api: "src/api.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: { only: true },
  },
]);
