import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";
import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");
const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "plan",
  name: "Plan",
  version: "0.1.0",
  description: "System-wide plans for coordinated mind activity",
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l2.5 2.5"/></svg>',
  color: "blue",
  routes: (ctx) => createRoutes(ctx),
  commands: createCommands(),
  initDb,
  skillsDir,
  standardSkill: true,
  ui: {
    assetsDir,
    systemSection: { id: "plan", label: "Plan", urlPatterns: ["/plan"] },
    feedSource: { endpoint: "/api/ext/plan/feed" },
  },
});
