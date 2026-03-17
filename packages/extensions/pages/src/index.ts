import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";

import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { createPublicRoutes, createRoutes } from "./routes.js";

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
  ui: {
    assetsDir,
    systemSection: {
      id: "pages",
      label: "Pages",
      urlPatterns: ["/pages", "/pages/:site", "/pages/:site/:path"],
    },
    mindSections: [
      {
        id: "pages",
        label: "Pages",
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/></svg>',
      },
    ],
    feedSource: {
      endpoint: "/api/ext/pages/feed",
    },
  },
});
