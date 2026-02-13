# Channel Slugs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace opaque platform IDs in channel URIs with human-readable slugs everywhere (routing, CLI, agent context, inbox files).

**Architecture:** Connectors generate slugs from channel metadata and write slug-to-platformId mappings to `.volute/channels.json`. Channel drivers resolve slugs back to platform IDs via this mapping. No migration — clean break, agents adapt through the existing invite/gating flow.

**Tech Stack:** TypeScript, Node.js `node:fs`, `node:path`. No new dependencies.

---

### Task 1: Add slugify and channel mapping helpers to connector SDK

**Files:**
- Modify: `src/connectors/sdk.ts`
- Create: `test/channel-slugs.test.ts`

**Step 1: Write the failing tests**

Create `test/channel-slugs.test.ts`:

```typescript
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { slugify, buildChannelSlug, writeChannelEntry, readChannelMap, resolveChannelId } from "../src/connectors/sdk.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    assert.equal(slugify("My Server"), "my-server");
  });

  it("replaces special chars with hyphens", () => {
    assert.equal(slugify("hello_world!@#test"), "hello-world-test");
  });

  it("collapses multiple hyphens", () => {
    assert.equal(slugify("a - - b"), "a-b");
  });

  it("trims leading/trailing hyphens", () => {
    assert.equal(slugify(" hello "), "hello");
  });

  it("handles empty string", () => {
    assert.equal(slugify(""), "");
  });

  it("preserves numbers", () => {
    assert.equal(slugify("Channel 42"), "channel-42");
  });
});

describe("buildChannelSlug", () => {
  it("builds guild channel slug: platform:server/channel", () => {
    assert.equal(
      buildChannelSlug("discord", { channelName: "general", serverName: "My Server" }),
      "discord:my-server/general"
    );
  });

  it("builds DM slug: platform:@username", () => {
    assert.equal(
      buildChannelSlug("discord", { isDM: true, senderName: "Alice" }),
      "discord:@alice"
    );
  });

  it("builds group DM slug with sorted participants", () => {
    assert.equal(
      buildChannelSlug("discord", { isDM: true, recipients: ["Charlie", "Alice", "Bob"] }),
      "discord:@alice,bob,charlie"
    );
  });

  it("builds telegram group slug", () => {
    assert.equal(
      buildChannelSlug("telegram", { channelName: "My Group Chat" }),
      "telegram:my-group-chat"
    );
  });

  it("falls back to platform ID when no name info available", () => {
    assert.equal(
      buildChannelSlug("discord", { platformId: "1234567890" }),
      "discord:1234567890"
    );
  });
});

describe("channel mapping", () => {
  it("writeChannelEntry creates channels.json and writes entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-test-"));
    const voluteDir = join(dir, ".volute");
    mkdirSync(voluteDir, { recursive: true });

    writeChannelEntry(dir, "discord:my-server/general", {
      platformId: "1234567890",
      platform: "discord",
      name: "#general",
      server: "My Server",
      type: "channel",
    });

    const map = JSON.parse(readFileSync(join(voluteDir, "channels.json"), "utf-8"));
    assert.equal(map["discord:my-server/general"].platformId, "1234567890");
  });

  it("writeChannelEntry merges with existing entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-test-"));
    const voluteDir = join(dir, ".volute");
    mkdirSync(voluteDir, { recursive: true });

    writeChannelEntry(dir, "discord:my-server/general", {
      platformId: "111", platform: "discord", type: "channel",
    });
    writeChannelEntry(dir, "discord:@alice", {
      platformId: "222", platform: "discord", type: "dm",
    });

    const map = JSON.parse(readFileSync(join(voluteDir, "channels.json"), "utf-8"));
    assert.equal(Object.keys(map).length, 2);
    assert.equal(map["discord:my-server/general"].platformId, "111");
    assert.equal(map["discord:@alice"].platformId, "222");
  });

  it("resolveChannelId returns platformId for known slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-test-"));
    const voluteDir = join(dir, ".volute");
    mkdirSync(voluteDir, { recursive: true });

    writeFileSync(join(voluteDir, "channels.json"), JSON.stringify({
      "discord:my-server/general": { platformId: "1234567890", platform: "discord" },
    }));

    assert.equal(resolveChannelId(dir, "discord:my-server/general"), "1234567890");
  });

  it("resolveChannelId returns slug suffix for unknown slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-test-"));
    const voluteDir = join(dir, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    writeFileSync(join(voluteDir, "channels.json"), "{}");

    assert.equal(resolveChannelId(dir, "discord:my-server/general"), "my-server/general");
  });

  it("resolveChannelId returns slug suffix when no channels.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-test-"));
    mkdirSync(join(dir, ".volute"), { recursive: true });
    assert.equal(resolveChannelId(dir, "discord:some-channel"), "some-channel");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/channel-slugs.test.ts`
Expected: FAIL — functions not exported from sdk.ts

**Step 3: Implement the helpers in `src/connectors/sdk.ts`**

Add to `src/connectors/sdk.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";  // already imported

/** Slugify a string: lowercase, replace non-alphanumeric with hyphens, collapse, trim. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export type ChannelSlugMeta = {
  channelName?: string;
  serverName?: string;
  isDM?: boolean;
  senderName?: string;
  recipients?: string[];  // for group DMs
  platformId?: string;    // fallback
};

/** Build a channel slug like discord:my-server/general or discord:@alice. */
export function buildChannelSlug(platform: string, meta: ChannelSlugMeta): string {
  // DM with multiple recipients (group DM)
  if (meta.isDM && meta.recipients && meta.recipients.length > 1) {
    const sorted = meta.recipients.map((r) => slugify(r)).sort();
    return `${platform}:@${sorted.join(",")}`;
  }

  // DM with single recipient
  if (meta.isDM && (meta.senderName || (meta.recipients && meta.recipients.length === 1))) {
    const name = meta.recipients?.[0] ?? meta.senderName ?? "unknown";
    return `${platform}:@${slugify(name)}`;
  }

  // Named channel with server
  if (meta.channelName && meta.serverName) {
    return `${platform}:${slugify(meta.serverName)}/${slugify(meta.channelName)}`;
  }

  // Named channel without server (e.g. telegram group)
  if (meta.channelName) {
    return `${platform}:${slugify(meta.channelName)}`;
  }

  // Fallback to platform ID
  if (meta.platformId) {
    return `${platform}:${meta.platformId}`;
  }

  return `${platform}:unknown`;
}

export type ChannelEntry = {
  platformId: string;
  platform: string;
  name?: string;
  server?: string;
  type?: "channel" | "dm" | "group";
};

/** Read the channel map from .volute/channels.json. Returns empty object if missing. */
export function readChannelMap(agentDir: string): Record<string, ChannelEntry> {
  const mapPath = resolve(agentDir, ".volute", "channels.json");
  if (!existsSync(mapPath)) return {};
  try {
    return JSON.parse(readFileSync(mapPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Write/update a single entry in .volute/channels.json. */
export function writeChannelEntry(agentDir: string, slug: string, entry: ChannelEntry): void {
  const voluteDir = resolve(agentDir, ".volute");
  mkdirSync(voluteDir, { recursive: true });
  const mapPath = resolve(voluteDir, "channels.json");
  const map = readChannelMap(agentDir);
  map[slug] = entry;
  writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n");
}

/** Resolve a channel slug to a platform ID. Returns the slug suffix if not found. */
export function resolveChannelId(agentDir: string, slug: string): string {
  const map = readChannelMap(agentDir);
  const entry = map[slug];
  if (entry) return entry.platformId;
  // Fallback: return everything after the first colon
  const colonIdx = slug.indexOf(":");
  return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/channel-slugs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/connectors/sdk.ts test/channel-slugs.test.ts
git commit -m "feat: add slugify and channel mapping helpers"
```

---

### Task 2: Update Discord connector to use slugs

**Files:**
- Modify: `src/connectors/discord.ts`

**Step 1: Update channel key construction in MessageCreate handler**

In `src/connectors/discord.ts`, replace the channel key construction and add channel mapping writes. The key changes:

1. Import the new helpers:
```typescript
import { buildChannelSlug, writeChannelEntry, slugify } from "./sdk.js";
```

2. In the `MessageCreate` handler, replace:
```typescript
const channelKey = `discord:${message.channelId}`;
```
with slug generation:
```typescript
const channelKey = isDM
  ? buildChannelSlug("discord", {
      isDM: true,
      recipients: [message.author.username],
    })
  : buildChannelSlug("discord", {
      channelName: channelName ?? message.channelId,
      serverName: message.guild?.name,
    });

// Write to channel map
if (env.agentDir) {
  writeChannelEntry(env.agentDir, channelKey, {
    platformId: message.channelId,
    platform: "discord",
    name: channelName ? `#${channelName}` : undefined,
    server: message.guild?.name,
    type: isDM ? "dm" : "channel",
  });
}
```

3. Update the `TypingStart` handler similarly:
```typescript
// Replace: reportTyping(env, `discord:${typing.channel.id}`, sender, true);
// With slug-based channel key (best effort — use cached guild/channel info)
const typingChannelKey = typing.guild
  ? `discord:${slugify(typing.guild.name)}/${slugify("name" in typing.channel ? (typing.channel as any).name : typing.channel.id)}`
  : `discord:@${slugify(typing.user.username)}`;
reportTyping(env, typingChannelKey, sender, true);
```

**Step 2: Run existing tests**

Run: `node --import tsx --test test/connector-defs.test.ts`
Expected: PASS (connector tests are structural, not integration)

**Step 3: Commit**

```bash
git add src/connectors/discord.ts
git commit -m "feat: discord connector uses human-readable channel slugs"
```

---

### Task 3: Update Slack connector to use slugs

**Files:**
- Modify: `src/connectors/slack.ts`

**Step 1: Update channel key construction in message handler**

1. Import helpers:
```typescript
import { buildChannelSlug, writeChannelEntry } from "./sdk.js";
```

2. Replace `const channelKey = \`slack:${message.channel}\`;` with:
```typescript
// Build slug from channel info
let dmRecipientName: string | undefined;
if (message.channel_type === "im") {
  dmRecipientName = senderName;
}

const channelKey = isDM
  ? buildChannelSlug("slack", {
      isDM: true,
      senderName: dmRecipientName,
    })
  : buildChannelSlug("slack", {
      channelName: channelName ?? message.channel,
      serverName,
    });

// Write to channel map
if (env.agentDir) {
  writeChannelEntry(env.agentDir, channelKey, {
    platformId: message.channel,
    platform: "slack",
    name: channelName ? `#${channelName}` : undefined,
    server: serverName,
    type: isDM ? "dm" : "channel",
  });
}
```

**Step 2: Run existing tests**

Run: `node --import tsx --test test/connector-defs.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/connectors/slack.ts
git commit -m "feat: slack connector uses human-readable channel slugs"
```

---

### Task 4: Update Telegram connector to use slugs

**Files:**
- Modify: `src/connectors/telegram.ts`

**Step 1: Update channel construction in both message handlers (text + photo)**

1. Import helpers:
```typescript
import { buildChannelSlug, writeChannelEntry } from "./sdk.js";
```

2. In both the `message("text")` and `message("photo")` handlers, replace:
```typescript
channel: `telegram:${ctx.chat.id}`,
```
with:
```typescript
const channelSlug = isDM
  ? buildChannelSlug("telegram", {
      isDM: true,
      senderName: ctx.message.from.username ?? ctx.message.from.first_name,
    })
  : buildChannelSlug("telegram", {
      channelName: chatTitle ?? String(ctx.chat.id),
    });

// Write to channel map
if (env.agentDir) {
  writeChannelEntry(env.agentDir, channelSlug, {
    platformId: String(ctx.chat.id),
    platform: "telegram",
    name: chatTitle,
    type: isDM ? "dm" : "channel",
  });
}
```

Then use `channelSlug` as the `channel` value in the payload.

**Step 2: Run existing tests**

Run: `node --import tsx --test test/connector-defs.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/connectors/telegram.ts
git commit -m "feat: telegram connector uses human-readable channel slugs"
```

---

### Task 5: Update channel drivers to resolve slugs

**Files:**
- Modify: `src/lib/channels/discord.ts`
- Modify: `src/lib/channels/slack.ts`
- Modify: `src/lib/channels/telegram.ts`
- Modify: `src/lib/channels.ts` (ChannelDriver interface)
- Modify: `src/commands/channel.ts` (pass agent dir to drivers)

**Step 1: Update ChannelDriver interface to accept agent dir**

The drivers need access to `channels.json` to resolve slugs. The simplest approach: the `env` record already passes `VOLUTE_AGENT_DIR` (set in `channel.ts` command). Add a `resolveChannelId` helper to `src/lib/channels.ts` that reads `.volute/channels.json`:

Add to `src/lib/channels.ts`:
```typescript
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function resolveChannelId(env: Record<string, string>, slug: string): string {
  const agentDir = env.VOLUTE_AGENT_DIR;
  if (!agentDir) {
    const colonIdx = slug.indexOf(":");
    return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
  }
  const mapPath = resolve(agentDir, ".volute", "channels.json");
  if (!existsSync(mapPath)) {
    const colonIdx = slug.indexOf(":");
    return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
  }
  try {
    const map = JSON.parse(readFileSync(mapPath, "utf-8"));
    const entry = map[slug];
    if (entry?.platformId) return entry.platformId;
  } catch {}
  const colonIdx = slug.indexOf(":");
  return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
}
```

**Step 2: Update Discord channel driver**

In `src/lib/channels/discord.ts`, update `read()` and `send()` to resolve the slug:

```typescript
import { resolveChannelId } from "../channels.js";

export async function read(env: Record<string, string>, channelSlug: string, limit: number): Promise<string> {
  const token = requireToken(env);
  const channelId = resolveChannelId(env, `discord:${channelSlug}`);
  // ... rest uses channelId for API call
}
```

Wait — the driver receives just the part after the colon (the `channelId` param from `parseUri`). But now it's a slug suffix like `my-server/general`. The driver needs the full slug to look up in the map.

**Better approach**: Pass the full URI (slug) to the driver, not just the part after the colon. Update `src/commands/channel.ts` to pass the full URI:

In `channel.ts`, change:
```typescript
const output = await driver.read(env, channelId, limit);
// to:
const output = await driver.read(env, uri, limit);
```

And similarly for `send()`. Then each driver resolves the full slug to a platform ID.

Alternatively, change `parseUri` to only extract the platform name for driver lookup, and pass the full URI to the driver. This is the simpler change.

Update `channel.ts`:
- Change `read` to pass `uri` instead of `channelId`
- Change `send` to pass `uri` instead of `channelId`
- The `parseUri` function is still used just to extract `platform` for driver lookup
- In the history POST, pass `uri` as the channel (it's already a slug)

Update each driver's `read`/`send`:
- Discord: `resolveChannelId(env, slug)` then use result as API channel ID
- Slack: same
- Telegram: same
- Volute: passes conversation ID to daemon API — extract from slug

**Step 3: Update Volute channel driver**

The volute driver is different — it talks to the daemon API using conversation IDs (which are UUIDs or numeric IDs). The slug would be `volute:conversation-title` or `volute:@username`. The volute driver would need its own slug resolution or use the same `channels.json` map.

For now, the volute channel driver can just strip the `volute:` prefix and use the remainder as-is if it's a UUID, or look up in channels.json if it's a slug.

**Step 4: Update `listConversations` in all drivers to return slugs**

Each driver's `listConversations` currently returns `{ id: "platform:platformId", name: "...", type: "..." }`. Update to return slugs:

Discord:
```typescript
// channels: id: `discord:${slugify(guild.name)}/${slugify(ch.name)}`
// DMs: id: `discord:@${slugify(recipients)}`
```

Slack:
```typescript
// channels: id: `slack:${slugify(serverName)}/${slugify(ch.name)}`
// DMs: id: `slack:@${slugify(username)}`
```

**Step 5: Update `channel list` to also write to channels.json**

When `listConversations` is called via `volute channel list`, also write each returned channel to `channels.json` so the map gets populated for channels the connector hasn't seen.

In `src/commands/channel.ts` `listChannels()`, after getting conversations:
```typescript
import { writeChannelEntry } from "../connectors/sdk.js";

// After listing, populate channels.json
const { dir } = resolveAgent(agentName);
for (const conv of convs) {
  const [platform, ...rest] = conv.id.split(":");
  // writeChannelEntry needs the original platform ID, which we now need to pass through
}
```

Actually, the `listConversations` function should return both the slug and the platform ID so we can write the mapping. Update `ChannelConversation` type:

```typescript
export type ChannelConversation = {
  id: string;         // slug URI (e.g. "discord:my-server/general")
  platformId: string; // raw platform ID (e.g. "1234567890")
  name: string;
  type: "dm" | "group" | "channel";
  participantCount?: number;
};
```

Each driver's `listConversations` returns both, and `listChannels` in `channel.ts` writes them to `channels.json`.

**Step 6: Run tests, update `test/channels.test.ts` as needed**

Run: `node --import tsx --test test/channels.test.ts`
Expected: Some tests may need updating if `getChannelProvider` test URIs change. Since `getChannelProvider` splits on `:` to get platform, and slug URIs still have `:`, these should still pass.

**Step 7: Commit**

```bash
git add src/lib/channels.ts src/lib/channels/discord.ts src/lib/channels/slack.ts src/lib/channels/telegram.ts src/lib/channels/volute.ts src/commands/channel.ts test/channels.test.ts
git commit -m "feat: channel drivers resolve human-readable slugs to platform IDs"
```

---

### Task 6: Update `listConversations` in Discord driver to return slugs

**Files:**
- Modify: `src/lib/channels/discord.ts`

**Step 1: Update `listConversations` to build slug IDs**

Import `slugify` from the connector SDK (or duplicate the function in channels.ts to avoid circular deps — since `src/lib/` shouldn't import from `src/connectors/`).

Better: extract `slugify` into a shared utility at `src/lib/slugify.ts` that both `src/connectors/sdk.ts` and `src/lib/channels/*.ts` can import.

Create `src/lib/slugify.ts`:
```typescript
/** Slugify a string: lowercase, replace non-alphanumeric with hyphens, collapse, trim. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
```

Then `src/connectors/sdk.ts` re-exports from it, and channel drivers import directly.

Update `listConversations` in discord driver:
```typescript
import { slugify } from "../slugify.js";

// For guild text channels:
results.push({
  id: `discord:${slugify(guild.name)}/${slugify(ch.name)}`,
  platformId: ch.id,
  name: `#${ch.name}`,
  type: "channel",
});

// For DMs:
const name = dm.recipients?.map((r) => r.username).join(", ") ?? "DM";
const slug = dm.recipients?.length === 1
  ? `discord:@${slugify(dm.recipients[0].username)}`
  : `discord:@${dm.recipients?.map((r) => slugify(r.username)).sort().join(",")}`;
results.push({
  id: slug,
  platformId: dm.id,
  name,
  type: dm.type === 1 ? "dm" : "group",
});
```

**Step 2: Run tests**

Run: `node --import tsx --test test/channels.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/slugify.ts src/lib/channels/discord.ts src/connectors/sdk.ts
git commit -m "feat: extract slugify to shared lib, update discord listConversations"
```

---

### Task 7: Update `listConversations` in Slack and Volute drivers

**Files:**
- Modify: `src/lib/channels/slack.ts`
- Modify: `src/lib/channels/volute.ts`

**Step 1: Update Slack `listConversations`**

```typescript
import { slugify } from "../slugify.js";

// Need workspace name — get from auth.test or env
// For channels: id: `slack:${slugify(workspaceName)}/${slugify(ch.name)}`
// For DMs: resolve user ID to username, then `slack:@${slugify(username)}`
```

Note: Slack DMs in `conversations.list` return user IDs, not names. Need to cross-reference with `users.list` to get usernames for slugs. This adds complexity but is necessary for human-readable DM slugs.

**Step 2: Update Volute `listConversations`**

```typescript
import { slugify } from "../slugify.js";

// For titled conversations: id: `volute:${slugify(title)}`
// For untitled: id: `volute:${conv.id}` (keep UUID as fallback)
```

**Step 3: Run tests**

Run: `node --import tsx --test test/channels.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/channels/slack.ts src/lib/channels/volute.ts
git commit -m "feat: update slack and volute listConversations to return slugs"
```

---

### Task 8: Update `channel list` command to populate channels.json

**Files:**
- Modify: `src/commands/channel.ts`

**Step 1: Import writeChannelEntry and populate map during listing**

In `listChannels()`, after getting conversations from each driver:

```typescript
import { writeChannelEntry, type ChannelEntry } from "../connectors/sdk.js";
import { resolveAgent } from "../lib/registry.js";

// In listChannels, after const convs = await driver.listConversations(env):
const { dir: agentDir } = resolveAgent(agentName);
for (const conv of convs) {
  writeChannelEntry(agentDir, conv.id, {
    platformId: conv.platformId,
    platform: p,
    name: conv.name,
    type: conv.type,
  });
}
```

**Step 2: Also pass VOLUTE_AGENT_DIR in env for read/send**

In `readChannel()` and `sendChannel()`, ensure `VOLUTE_AGENT_DIR` is in the env passed to drivers:

```typescript
const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };
```

**Step 3: Update read/send to pass full URI to driver**

Change from:
```typescript
const output = await driver.read(env, channelId, limit);
```
to:
```typescript
const output = await driver.read(env, uri, limit);
```

And same for `send()`.

**Step 4: Run all tests**

Run: `node --import tsx --test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/channel.ts
git commit -m "feat: channel list populates channels.json, read/send pass full URI"
```

---

### Task 9: Update `createConversation` in drivers to return slugs

**Files:**
- Modify: `src/lib/channels/discord.ts`
- Modify: `src/lib/channels/slack.ts`
- Modify: `src/lib/channels/volute.ts`
- Modify: `src/commands/channel.ts`

**Step 1: Update `createConversation` return value**

Each driver's `createConversation` currently returns a platform ID. Update to return a slug and write to channels.json.

Discord:
```typescript
export async function createConversation(
  env: Record<string, string>,
  participants: string[],
  _name?: string,
): Promise<string> {
  // ... existing code to create DM ...
  const slug = `discord:@${slugify(participants[0])}`;
  // Write mapping if agent dir available
  if (env.VOLUTE_AGENT_DIR) {
    writeChannelEntry(env.VOLUTE_AGENT_DIR, slug, {
      platformId: dm.id,
      platform: "discord",
      name: participants[0],
      type: "dm",
    });
  }
  return slug;  // Was: return dm.id
}
```

**Step 2: Update `channel create` command output**

In `channel.ts` `createChannel()`, the output already does `console.log(\`${platform}:${id}\`)`. Since `createConversation` now returns a full slug, just print it directly:
```typescript
const slug = await driver.createConversation(env, participants, flags.name);
console.log(slug);  // Was: console.log(`${platform}:${id}`)
```

**Step 3: Run tests**

Run: `node --import tsx --test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/channels/discord.ts src/lib/channels/slack.ts src/lib/channels/volute.ts src/commands/channel.ts
git commit -m "feat: createConversation returns slugs, writes to channels.json"
```

---

### Task 10: Run full test suite, fix any breakage

**Files:**
- Potentially modify: any test files with hardcoded `platform:numericId` channel URIs

**Step 1: Run the full test suite**

Run: `node --import tsx --test`

**Step 2: Fix any failing tests**

Common issues to look for:
- Tests that assert channel URIs like `discord:456` — these may need updating to slug format
- Tests for `getChannelProvider` — should still work since it only looks at the platform prefix
- Routing tests — channel values in test data may need updating

**Step 3: Run full test suite again**

Run: `node --import tsx --test`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "test: fix tests for channel slug format"
```

---

### Task 11: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update channel-related documentation in CLAUDE.md**

Update the CLAUDE.md to document the new slug format and channels.json. Key sections to update:
- Channel driver descriptions
- commands/channel.ts description
- Any mentions of channel URI format

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for channel slug format"
```
