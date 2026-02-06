import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/lib/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: `file:${resolve(homedir(), ".volute", "volute.db")}` },
});
