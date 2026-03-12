import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";

import { createPublicRoutes, createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillDir = resolve(import.meta.dirname, "../pages");

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

export default createExtension({
  id: "pages",
  name: "Pages",
  version: "0.1.0",
  description: "Publish and serve web pages from mind directories",
  routes: (ctx) => createRoutes(ctx),
  publicRoutes: (ctx) => createPublicRoutes(ctx),
  skillDir,
  standardSkill: true,
  ui: {
    assetsDir,
    systemSections: [
      {
        id: "pages",
        label: "Pages",
        urlPatterns: ["/pages", "/pages/:site", "/pages/:site/:path"],
      },
    ],
    mindSections: [{ id: "pages", label: "Pages" }],
    feedSource: {
      endpoint: "/api/ext/pages/feed",
    },
  },
  onDaemonStart: () => {
    getWatcher()
      .then((w) => w.startSystemWatcher())
      .catch(() => {});
  },
  onDaemonStop: () => {
    getWatcher()
      .then((w) => w.stopAllWatchers())
      .catch(() => {});
  },
  onMindStart: (mindName: string) => {
    getWatcher()
      .then((w) => w.startWatcher(mindName))
      .catch(() => {});
  },
  onMindStop: (mindName: string) => {
    getWatcher()
      .then((w) => w.stopWatcher(mindName))
      .catch(() => {});
  },
});
