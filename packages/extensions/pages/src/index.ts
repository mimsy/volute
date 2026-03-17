import { resolve } from "node:path";
import type { CommandHandler } from "@volute/extensions";
import { createExtension } from "@volute/extensions";

import { createPublicRoutes, createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

// Lazy-loaded pages-watcher from core (built-in extension can import core modules)
let _watcher: {
  startWatcher: (name: string) => void;
  stopWatcher: (name: string) => void;
  startSystemWatcher: () => void;
  stopAllWatchers: () => void;
} | null = null;

async function getWatcher() {
  if (_watcher) return _watcher;
  _watcher = await import("../../../../src/lib/pages-watcher.js");
  return _watcher;
}

const notifyHandler: CommandHandler = async (args, ctx) => {
  const mindName = ctx.mindName;
  if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

  const file = args[0] || "page";
  ctx.publishActivity({
    type: "page_updated",
    mind: mindName,
    summary: `${mindName} updated ${file}`,
    metadata: { file, iframeUrl: `/ext/pages/public/${mindName}/${file}` },
  });

  // Invalidate the pages cache
  try {
    const mod = await import("../../../../src/lib/pages-watcher.js");
    mod.invalidateCache();
  } catch {
    // not critical
  }

  return { output: `Notified: ${file}` };
};

export default createExtension({
  id: "pages",
  name: "Pages",
  version: "0.1.0",
  description: "Publish and serve web pages from mind directories",
  routes: (ctx) => createRoutes(ctx),
  publicRoutes: (ctx) => createPublicRoutes(ctx),
  commands: {
    notify: {
      description: "Notify that a page was created or updated",
      usage: "volute pages notify [filename]",
      handler: notifyHandler,
    },
  },
  skillsDir,
  standardSkill: true,
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M1 5h14"/><circle cx="3" cy="3.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="5" cy="3.5" r="0.5" fill="currentColor" stroke="none"/></svg>',
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
  onDaemonStart: () => {
    getWatcher()
      .then((w) => w.startSystemWatcher())
      .catch((err) =>
        console.error("[pages] failed to start system watcher:", (err as Error).message),
      );
  },
  onDaemonStop: () => {
    getWatcher()
      .then((w) => w.stopAllWatchers())
      .catch((err) => console.error("[pages] failed to stop watchers:", (err as Error).message));
  },
  onMindStart: (mindName: string) => {
    getWatcher()
      .then((w) => w.startWatcher(mindName))
      .catch((err) =>
        console.error(`[pages] failed to start watcher for ${mindName}:`, (err as Error).message),
      );
  },
  onMindStop: (mindName: string) => {
    getWatcher()
      .then((w) => w.stopWatcher(mindName))
      .catch((err) =>
        console.error(`[pages] failed to stop watcher for ${mindName}:`, (err as Error).message),
      );
  },
});
