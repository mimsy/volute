import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// The schema moved to packages/daemon during the monorepo split. Point migrations at
// a scratch DB under ./drizzle (env-overridable) rather than the live ~/.volute DB so
// `npm run db:generate`/`migrate` can never touch a running install's data.
export default defineConfig({
  out: "./drizzle",
  schema: "./packages/daemon/src/lib/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${process.env.VOLUTE_DRIZZLE_DB ?? resolve(process.cwd(), "drizzle", "dev.db")}`,
  },
});
