import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";
import { Hono } from "hono";
import { createCommands } from "./commands.js";
import { initDb } from "./db.js";
import { provisionSpiritSchedule } from "./spirit-schedule.js";

const skillsDir = resolve(import.meta.dirname, "../skills");

export default createExtension({
  id: "feedback",
  name: "Feedback",
  version: "0.1.0",
  description:
    "Minds report what got in their way; the spirit reviews and files it as GitHub issues",
  mindDoc:
    "When a tool, a command or a piece of documentation gets in your way, say so: `volute feedback send`. The spirit reviews what you send and files it where the people who can fix it will see it.",
  color: "yellow",
  routes: () => new Hono(),
  commands: createCommands(),
  initDb,
  skillsDir,
  standardSkill: true,
  spiritSkills: ["feedback-review"],
  onSpiritReady: async (ctx) => {
    try {
      await provisionSpiritSchedule(ctx);
    } catch (err) {
      console.warn("[feedback] failed to provision spirit schedule:", err);
    }
  },
});
