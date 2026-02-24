# CLI-Daemon Boundary Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure all CLI commands proxy through the daemon HTTP API rather than accessing shared state directly.

**Architecture:** Each fix follows the same pattern — replace direct file/DB/driver access in CLI commands with `daemonFetch()` calls, adding or extending daemon API endpoints where needed.

**Tech Stack:** TypeScript, Hono (daemon API), `daemonFetch()` from `src/lib/daemon-client.ts`

---

### Task 1: `variant list` — use existing daemon endpoint

The daemon already has `GET /api/minds/:name/variants` that reads `variants.json`, health-checks variants, and returns results. The CLI duplicates all of this with direct file access + writes.

**Files:**
- Modify: `src/commands/variant.ts` (lines 103–154, the `listVariants` function)
- Modify: `src/web/api/variants.ts` (line 35, make GET endpoint also write back dead-variant status)

**Changes:**

In `src/web/api/variants.ts`, the GET endpoint currently returns results but doesn't update `variants.json` for dead variants. Add `writeVariants()` to sync the running state (matching what the CLI currently does):

```typescript
// After computing results, update variants.json
const updated = results.map(({ status, ...v }) => ({
  ...v,
  running: status === "running",
}));
writeVariants(name, updated);
```

In `src/commands/variant.ts`, replace `listVariants` to use `daemonFetch()`:

```typescript
async function listVariants(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    json: { type: "boolean" },
  });

  const mindName = resolveMindName(flags);
  const { json } = flags;

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].variants.$url({ param: { name: mindName } })),
  );

  if (!res.ok) {
    const data = await res.json() as { error?: string };
    console.error(data.error ?? "Failed to list variants");
    process.exit(1);
  }

  const results = await res.json() as (Variant & { status: string })[];

  // ... same display logic as before
}
```

Remove imports of `resolveMind`, `checkHealth`, `readVariants`, `writeVariants` from variant.ts (keep `type Variant` if still needed for the display type).

Run `npm test`, commit.

---

### Task 2: `sprout` — proxy skill installs through daemon API

The daemon has skill endpoints: `POST /api/minds/:name/skills/install` and `DELETE /api/minds/:name/skills/:skill`. Use these instead of calling `installSkill`/`uninstallSkill` directly.

**Files:**
- Modify: `src/commands/sprout.ts`

**Changes:**

Replace the direct `installSkill()` loop (lines 50–67) with daemon calls:

```typescript
for (const skillId of STANDARD_SKILLS) {
  const skillDir = resolve(dir, "home", ".claude", "skills", skillId);
  if (!existsSync(skillDir)) {
    const installRes = await daemonFetch(
      urlOf(client.api.minds[":name"].skills.install.$url({ param: { name: mindName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId }),
      },
    );
    if (!installRes.ok) {
      const data = await installRes.json() as { error?: string };
      console.error(`Failed to install skill ${skillId}: ${data.error}`);
      failedSkills.push(skillId);
    }
  }
}
```

Replace the direct `uninstallSkill()` call (lines 69–77) with a daemon call:

```typescript
const orientationDir = resolve(dir, "home", ".claude", "skills", "orientation");
if (existsSync(orientationDir)) {
  const delRes = await daemonFetch(
    urlOf(client.api.minds[":name"].skills[":skill"].$url({ param: { name: mindName, skill: "orientation" } })),
    { method: "DELETE" },
  );
  if (!delRes.ok) {
    const data = await delRes.json() as { error?: string };
    console.error(`Failed to uninstall orientation skill: ${data.error}`);
  }
}
```

Move the `daemonFetch`/`getClient` imports to the top of the function (before the skill loop), since they're now needed earlier. Remove `installSkill`, `uninstallSkill`, `getSharedSkill` imports. Keep `STANDARD_SKILLS` (it's just a constant array). The `findMind`, `mindDir` imports are still needed for the `existsSync` checks on SOUL.md/MEMORY.md/skill dirs.

Run `npm test`, commit.

---

### Task 3: `export --include-history` — add daemon endpoint

**Files:**
- Modify: `src/web/api/minds.ts` — add `GET /:name/history/export` endpoint
- Modify: `src/commands/export.ts` — use `daemonFetch()` instead of direct DB access

**Changes:**

Add a new endpoint in `src/web/api/minds.ts` near the existing history endpoints (around line 1741):

```typescript
.get("/:name/history/export", async (c) => {
  const name = c.req.param("name");
  if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

  const db = await getDb();
  const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
  return c.json(rows);
})
```

In `src/commands/export.ts`, replace the direct DB access (lines 56–68) with a daemon call:

```typescript
if (includeHistory) {
  try {
    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();
    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].history.export.$url({ param: { name } })),
    );
    if (!res.ok) throw new Error("Failed to fetch history");
    const rows = await res.json();
    addHistoryToArchive(zip, rows);
  } catch (err) {
    console.error(`Error: could not export history: ${(err as Error).message}`);
    process.exit(1);
  }
}
```

Remove the `db.js`, `drizzle-orm`, and `schema.js` imports from `export.ts`.

Also remove the direct `findMind` and `mindDir` imports — the existence check can come from the daemon response (if the mind doesn't exist, the daemon will return 404). But we still need `mindDir` for `createExportArchive` which reads files. Actually, `createExportArchive` reads the mind directory directly — that's a filesystem read which is fine for the CLI. Keep `findMind` and `mindDir` for now.

Run `npm test`, commit.

---

### Task 4: `send` Volute DMs — route through daemon

The daemon already has `POST /:name/channels/create` and `POST /:name/channels/send`. Use these for the Volute DM path.

**Files:**
- Modify: `src/commands/send.ts` (lines 89–141, the Volute DM branch)

**Changes:**

Replace the direct driver calls with daemon API calls:

```typescript
if (parsed.isDM && parsed.platform === "volute") {
  const targetName = parsed.identifier.slice(1);
  const mindSelf = process.env.VOLUTE_MIND;
  const sender = mindSelf || userInfo().username;

  const targetIsMind = !!findMind(targetName);
  const contextMind = mindSelf && !targetIsMind ? mindSelf : targetName;
  const participants = mindSelf && !targetIsMind ? [targetName] : [sender];

  // Create/find conversation via daemon
  const createRes = await daemonFetch(
    urlOf(client.api.minds[":name"].channels.create.$url({ param: { name: contextMind } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "volute", participants }),
    },
  );
  if (!createRes.ok) {
    const data = await createRes.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }
  const { slug } = await createRes.json() as { slug: string };
  channelUri = slug;

  // Send via daemon
  const sendRes = await daemonFetch(
    urlOf(client.api.minds[":name"].channels.send.$url({ param: { name: contextMind } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "volute", uri: channelUri, message: message ?? "", images }),
    },
  );
  if (!sendRes.ok) {
    const data = await sendRes.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }
  console.log("Message sent.");

  // History persistence (same as before)
  if (mindSelf) {
    // ... existing history persistence code
  }
} else {
  // ... existing non-DM path (already correct)
}
```

Remove `getChannelDriver` import from send.ts (no longer used). Keep `findMind` (still needed for the bare-name-to-DM detection and `targetIsMind` check).

Run `npm test`, commit.

---

### Task 5: `start`/`stop`/`restart` — return port from daemon

**Files:**
- Modify: `src/web/api/minds.ts` — add `port` to start/restart/stop responses
- Modify: `src/commands/start.ts` — get port from response, remove `resolveMind`
- Modify: `src/commands/stop.ts` — remove `resolveMind`
- Modify: `src/commands/restart.ts` — get port from response, remove `resolveMind`

**Changes:**

In daemon `src/web/api/minds.ts`:

For start (line 849): `return c.json({ ok: true, port: entry.port });`
For restart (around line 985): `return c.json({ ok: true, port: entry.port });`
For stop (line 1008): `return c.json({ ok: true });` (no port needed)

In `src/commands/start.ts`:
```typescript
import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: volute mind start <name>");
    process.exit(1);
  }

  const client = getClient();
  const res = await daemonFetch(urlOf(client.api.minds[":name"].start.$url({ param: { name } })), {
    method: "POST",
  });

  const data = await res.json() as { ok?: boolean; error?: string; port?: number };

  if (!res.ok) {
    console.error(data.error || "Failed to start mind");
    process.exit(1);
  }

  console.log(`${name} started on port ${data.port}`);
}
```

Similar for restart.ts. For stop.ts, just remove the `resolveMind` call since it's only used for validation (the daemon validates too).

Remove the `resolveMind` import from all three files. Remove the `registry.js` import entirely if `resolveMind` was the only thing imported.

Run `npm test`, commit.

---

### Task 6: Final verification

Run `npm run build` and `npm test` to confirm everything works.

Commit message for any doc updates if needed.
