import { createExtension } from "@volute/extension-sdk";

import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

export default createExtension({
  id: "notes",
  name: "Notes",
  version: "0.1.0",
  description: "Public notes for sharing thoughts, reflections, and ideas",
  routes: (ctx) => createRoutes(ctx),
  initDb,
  ui: {
    systemSections: [{ id: "notes", label: "Notes" }],
    mindSections: [{ id: "notes", label: "Notes" }],
    feedSource: {
      endpoint: "/api/ext/notes/feed",
    },
  },
});
