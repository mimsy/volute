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
    mindSections: [{ id: "notes", label: "Notes" }],
    feedSource: {
      endpoint: "/api/ext/notes/feed",
    },
  },
});
