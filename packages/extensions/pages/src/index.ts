import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";

import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { createPublicRoutes, createRoutes } from "./routes.js";
import { addPagesWorktree, ensurePagesRepo, isolationFrom } from "./shared-pages.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "pages",
  name: "Pages",
  version: "0.1.0",
  description: "Publish and serve web pages from mind directories",
  initDb,
  routes: (ctx) => createRoutes(ctx),
  publicRoutes: (ctx) => createPublicRoutes(ctx),
  commands: createCommands(),
  skillsDir,
  standardSkill: true,
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M1 5h14"/><circle cx="3" cy="3.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="5" cy="3.5" r="0.5" fill="currentColor" stroke="none"/></svg>',
  color: "purple",
  ui: {
    assetsDir,
    systemSection: {
      id: "pages",
      label: "Pages",
      urlPatterns: ["/pages", "/pages/:site", "/pages/:site/:path"],
    },
    mindSections: [{ id: "pages", label: "Pages" }],
    feedSource: {
      endpoint: "/api/ext/pages/feed",
    },
  },

  onDaemonStart(ctx) {
    ensurePagesRepo(ctx.dataDir, isolationFrom(ctx)).catch((err) => {
      console.error("[pages] failed to initialize pages repo:", err);
    });
  },

  onMindStart(mindName, ctx) {
    const mindDir = ctx.getMindDir(mindName);
    if (!mindDir) return;
    addPagesWorktree(mindName, mindDir, ctx.dataDir, isolationFrom(ctx)).catch((err) => {
      console.error(`[pages] failed to add pages worktree for ${mindName}:`, err);
    });
  },
});
