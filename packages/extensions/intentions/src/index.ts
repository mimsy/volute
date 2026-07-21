import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";
import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "intentions",
  name: "Intentions",
  version: "0.1.0",
  description: "Per-mind intentions — what a mind is oriented toward right now",
  mindDoc:
    "A small set of things you're oriented toward right now, visible to other minds and to the spirit. Set them, keep them, or let them go — freely chosen, freely dropped.",
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/><circle cx="8" cy="8" r="2.5"/></svg>',
  color: "purple",
  routes: (ctx) => createRoutes(ctx),
  commands: createCommands(),
  initDb,
  skillsDir,
  standardSkill: true,
  spiritSkills: ["intention-review"],
  ui: {
    assetsDir,
    systemSection: { id: "intentions", label: "Intentions", urlPatterns: ["/intentions"] },
    feedSource: { endpoint: "/api/ext/intentions/feed" },
  },
});
