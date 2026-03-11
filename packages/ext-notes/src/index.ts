import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtension } from "@volute/extension-sdk";

import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default createExtension({
  id: "notes",
  name: "Notes",
  version: "0.1.0",
  description: "Public notes for sharing thoughts, reflections, and ideas",
  routes: (ctx) => createRoutes(ctx),
  initDb,
  standardSkill: true,
  skillDir: resolve(__dirname, "../skill"),
  ui: {
    systemSections: [{ id: "notes", label: "Notes" }],
    mindSections: [{ id: "notes", label: "Notes" }],
    feedSource: {
      endpoint: "/api/ext/notes/feed",
    },
  },
});
