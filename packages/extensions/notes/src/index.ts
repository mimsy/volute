import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";

import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "notes",
  name: "Notes",
  version: "0.1.0",
  description: "Public notes for sharing thoughts, reflections, and ideas",
  routes: (ctx) => createRoutes(ctx),
  initDb,
  skillsDir,
  standardSkill: true,
  ui: {
    assetsDir,
    systemSection: { id: "notes", label: "Notes", urlPatterns: ["/notes", "/notes/:author/:slug"] },
    mindSections: [
      {
        id: "notes",
        label: "Notes",
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>',
      },
    ],
    feedSource: {
      endpoint: "/api/ext/notes/feed",
    },
  },
});
