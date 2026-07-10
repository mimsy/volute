import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import config from "../drizzle.config.js";

// Guards the two stale-path bugs from #335 item 5: after the monorepo split the schema
// path and the live-DB credentials in drizzle.config.ts silently rotted, leaving
// `npm run db:generate` broken and (if it ran) pointed at the real ~/.volute database.
describe("drizzle.config", () => {
  it("points schema at the real (post-monorepo) schema file", () => {
    const schema = config.schema as string;
    assert.ok(schema, "schema path must be set");
    assert.ok(existsSync(resolve(process.cwd(), schema)), `schema path does not exist: ${schema}`);
  });

  it("never targets the live ~/.volute database", () => {
    const url = (config.dbCredentials as { url: string }).url;
    const liveDb = resolve(homedir(), ".volute");
    assert.ok(!url.includes(liveDb), `db url must not point at the live install: ${url}`);
    assert.ok(url.includes("drizzle"), `db url should live under ./drizzle: ${url}`);
  });
});
