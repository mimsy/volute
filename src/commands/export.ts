import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addHistoryToArchive, createExportArchive } from "../lib/archive.js";
import { parseArgs } from "../lib/parse-args.js";
import { findMind, mindDir } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    "include-env": { type: "boolean" },
    "include-identity": { type: "boolean" },
    "include-connectors": { type: "boolean" },
    "include-history": { type: "boolean" },
    "include-sessions": { type: "boolean" },
    all: { type: "boolean" },
    output: { type: "string" },
  });

  const name = positional[0];
  if (!name) {
    console.error(
      "Usage: volute mind export <name> [--include-env] [--include-identity] [--include-connectors] [--include-history] [--include-sessions] [--all] [--output <path>]",
    );
    process.exit(1);
  }

  const entry = findMind(name);
  if (!entry) {
    console.error(`Unknown mind: ${name}`);
    process.exit(1);
  }

  const dir = mindDir(name);
  if (!existsSync(dir)) {
    console.error(`Mind directory missing: ${dir}`);
    process.exit(1);
  }

  const includeAll = flags.all;
  const includeEnv = includeAll || flags["include-env"];
  const includeIdentity = includeAll || flags["include-identity"];
  const includeConnectors = includeAll || flags["include-connectors"];
  const includeHistory = includeAll || flags["include-history"];
  const includeSessions = includeAll || flags["include-sessions"];

  const zip = createExportArchive({
    name,
    template: entry.template ?? "claude",
    includeEnv,
    includeIdentity,
    includeConnectors,
    includeHistory,
    includeSessions,
  });

  // Add history from DB if requested
  if (includeHistory) {
    try {
      const { getDb } = await import("../lib/db.js");
      const { eq } = await import("drizzle-orm");
      const { mindHistory } = await import("../lib/schema.js");
      const db = await getDb();
      const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
      addHistoryToArchive(zip, rows);
    } catch (err) {
      console.warn("Warning: could not export history:", (err as Error).message);
    }
  }

  const outputPath = resolve(flags.output ?? `${name}.volute`);
  writeFileSync(outputPath, zip.toBuffer());

  const sizeMB = (zip.toBuffer().length / 1024 / 1024).toFixed(2);
  console.log(`\nExported ${name} → ${outputPath} (${sizeMB} MB)`);

  const included: string[] = [];
  const excluded: string[] = [];
  for (const [key, val] of [
    ["env", includeEnv],
    ["identity", includeIdentity],
    ["connectors", includeConnectors],
    ["history", includeHistory],
    ["sessions", includeSessions],
  ] as const) {
    (val ? included : excluded).push(key);
  }

  if (included.length > 0) console.log(`  Included: ${included.join(", ")}`);
  if (excluded.length > 0) console.log(`  Excluded: ${excluded.join(", ")}`);
}
