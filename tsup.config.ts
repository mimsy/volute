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
      // Pulls in jsdom, which does a dynamic require("path") at load time.
      // tsup's ESM __require shim can't satisfy that, so bundling it makes the
      // pages extension throw "Dynamic require of \"path\" is not supported" and
      // silently fail to load. Keep it external and installed at runtime.
      "isomorphic-dompurify",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
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
