import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";

const ORIENTATION_MARKER = "You don't have a soul yet";

export async function run(args: string[]) {
  const { positional } = parseArgs(args, {});
  const name = positional[0];

  if (!name) {
    console.error("Usage: volute seed check <name>");
    process.exit(1);
  }

  const { findMind, mindDir } = await import("../lib/registry.js");
  const entry = await findMind(name);
  if (!entry || entry.stage !== "seed") {
    // Not a seed — exit silently
    return;
  }

  const { getDb } = await import("../lib/db.js");
  const { mindHistory } = await import("../lib/schema.js");
  const { desc, eq, and, ne, sql } = await import("drizzle-orm");
  const db = await getDb();

  // Find last creator message (inbound, sender is not "volute" and not the seed itself)
  const lastCreatorMsg = await db
    .select({ created_at: mindHistory.created_at })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, name),
        eq(mindHistory.type, "inbound"),
        ne(mindHistory.sender, "volute"),
        ne(mindHistory.sender, name),
        sql`${mindHistory.sender} IS NOT NULL`,
      ),
    )
    .orderBy(desc(mindHistory.created_at))
    .limit(1);

  // Find last spirit message (inbound, sender is "volute")
  const lastSpiritMsg = await db
    .select({ created_at: mindHistory.created_at })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, name),
        eq(mindHistory.type, "inbound"),
        eq(mindHistory.sender, "volute"),
      ),
    )
    .orderBy(desc(mindHistory.created_at))
    .limit(1);

  const now = Date.now();
  const creatorTime = lastCreatorMsg[0] ? new Date(lastCreatorMsg[0].created_at).getTime() : 0;
  const spiritTime = lastSpiritMsg[0] ? new Date(lastSpiritMsg[0].created_at).getTime() : 0;

  const minutesSinceCreator = creatorTime ? (now - creatorTime) / 60_000 : Infinity;
  const minutesSinceSpirit = spiritTime ? (now - spiritTime) / 60_000 : Infinity;

  // No nudge if creator was active recently AND spirit messaged recently
  const creatorThreshold = Number(process.env.VOLUTE_NURTURE_CREATOR_MINUTES) || 5;
  const spiritThreshold = Number(process.env.VOLUTE_NURTURE_SPIRIT_MINUTES) || 15;
  if (minutesSinceCreator < creatorThreshold && minutesSinceSpirit < spiritThreshold) {
    return;
  }

  // Collect state
  const dir = mindDir(name);
  const soulPath = resolve(dir, "home/SOUL.md");
  const memoryPath = resolve(dir, "home/MEMORY.md");

  const soulCustom =
    existsSync(soulPath) && !readFileSync(soulPath, "utf-8").includes(ORIENTATION_MARKER);
  const memoryWritten =
    existsSync(memoryPath) && readFileSync(memoryPath, "utf-8").trim().length > 0;

  const { readVoluteConfig } = await import("../lib/volute-config.js");
  const config = readVoluteConfig(dir);
  const displayNameSet = !!config?.profile?.displayName;
  const avatarSet = !!config?.profile?.avatar;

  const { isImagegenEnabled } = await import("../lib/setup.js");
  const imagegenEnabled = isImagegenEnabled();

  // Build summary
  const done: string[] = [];
  const remaining: string[] = [];

  if (soulCustom) done.push("SOUL.md written");
  else remaining.push("Write SOUL.md");

  if (memoryWritten) done.push("MEMORY.md written");
  else remaining.push("Write MEMORY.md");

  if (displayNameSet) done.push("Display name set");
  else remaining.push("Set display name");

  if (imagegenEnabled) {
    if (avatarSet) done.push("Avatar set");
    else remaining.push("Generate and set avatar");
  }

  const creatorStatus =
    minutesSinceCreator === Infinity
      ? "No creator messages yet"
      : `Last creator message: ${Math.round(minutesSinceCreator)} minutes ago`;

  console.log(`Seed: ${name}`);
  console.log(creatorStatus);
  if (done.length > 0) console.log(`Done: ${done.join(", ")}`);
  if (remaining.length > 0) console.log(`Remaining: ${remaining.join(", ")}`);
  if (remaining.length > 0) {
    console.log(`\nDM the seed to encourage them: echo "message" | volute chat send @${name}`);
  } else {
    console.log(
      `\nAll checklist items complete — the seed can run \`volute seed sprout\` when ready.`,
    );
  }
}
