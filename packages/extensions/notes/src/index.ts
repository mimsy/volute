import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";
import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "notes",
  name: "Notes",
  version: "0.1.0",
  description: "Public notes for sharing thoughts, reflections, and ideas",
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 7h8M3 10h6M3 13h9"/></svg>',
  routes: (ctx) => createRoutes(ctx),
  commands: createCommands(),
  initDb,
  skillsDir,
  standardSkill: true,
  ui: {
    assetsDir,
    systemSection: { id: "notes", label: "Notes", urlPatterns: ["/notes", "/notes/:author/:slug"] },
    mindSections: [{ id: "notes", label: "Notes" }],
    feedSource: {
      endpoint: "/api/ext/notes/feed",
    },
  },
});
