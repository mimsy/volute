# Typing Indicators Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add typing indicators so agents can see who's typing before responding, and the web UI shows typing state for all participants.

**Architecture:** The daemon maintains an in-memory typing state map. Connectors and the web frontend report/query typing via the same HTTP API. The message proxy enriches payloads with current typing state. Agent turn tracking uses open ndjson streams.

**Tech Stack:** TypeScript, Hono, React, discord.js, node:test

---

### Task 1: Typing state module

**Files:**
- Create: `src/lib/typing.ts`
- Test: `test/typing.test.ts`

**Step 1: Write the failing test**

Create `test/typing.test.ts`:

```ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TypingMap } from "../src/lib/typing.js";

describe("TypingMap", () => {
  let map: TypingMap;

  beforeEach(() => {
    map = new TypingMap();
  });

  afterEach(() => {
    map.dispose();
  });

  it("returns empty array for unknown channel", () => {
    assert.deepEqual(map.get("discord:123"), []);
  });

  it("tracks a sender typing in a channel", () => {
    map.set("discord:123", "alice");
    assert.deepEqual(map.get("discord:123"), ["alice"]);
  });

  it("tracks multiple senders in a channel", () => {
    map.set("discord:123", "alice");
    map.set("discord:123", "bob");
    const result = map.get("discord:123");
    assert.equal(result.length, 2);
    assert.ok(result.includes("alice"));
    assert.ok(result.includes("bob"));
  });

  it("removes a sender when cleared", () => {
    map.set("discord:123", "alice");
    map.set("discord:123", "bob");
    map.delete("discord:123", "alice");
    assert.deepEqual(map.get("discord:123"), ["bob"]);
  });

  it("does not return expired entries", () => {
    map.set("discord:123", "alice", { ttlMs: 0 });
    assert.deepEqual(map.get("discord:123"), []);
  });

  it("persistent entries do not expire", () => {
    map.set("discord:123", "agent", { persistent: true });
    assert.deepEqual(map.get("discord:123"), ["agent"]);
  });

  it("channels are independent", () => {
    map.set("discord:123", "alice");
    map.set("discord:456", "bob");
    assert.deepEqual(map.get("discord:123"), ["alice"]);
    assert.deepEqual(map.get("discord:456"), ["bob"]);
  });

  it("refreshing updates expiry", () => {
    map.set("discord:123", "alice", { ttlMs: 100 });
    map.set("discord:123", "alice", { ttlMs: 10000 });
    assert.deepEqual(map.get("discord:123"), ["alice"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="TypingMap"`
Expected: FAIL — module does not exist

**Step 3: Write minimal implementation**

Create `src/lib/typing.ts`:

```ts
const DEFAULT_TTL_MS = 10_000;
const SWEEP_INTERVAL_MS = 5_000;

type Entry = { expiresAt: number };

export class TypingMap {
  private channels = new Map<string, Map<string, Entry>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  set(channel: string, sender: string, opts?: { ttlMs?: number; persistent?: boolean }): void {
    let senders = this.channels.get(channel);
    if (!senders) {
      senders = new Map();
      this.channels.set(channel, senders);
    }
    const expiresAt = opts?.persistent ? Infinity : Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS);
    senders.set(sender, { expiresAt });
  }

  delete(channel: string, sender: string): void {
    const senders = this.channels.get(channel);
    if (!senders) return;
    senders.delete(sender);
    if (senders.size === 0) this.channels.delete(channel);
  }

  get(channel: string): string[] {
    const senders = this.channels.get(channel);
    if (!senders) return [];
    const now = Date.now();
    const result: string[] = [];
    for (const [sender, entry] of senders) {
      if (entry.expiresAt > now) {
        result.push(sender);
      }
    }
    return result;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.channels.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [channel, senders] of this.channels) {
      for (const [sender, entry] of senders) {
        if (entry.expiresAt <= now) senders.delete(sender);
      }
      if (senders.size === 0) this.channels.delete(channel);
    }
  }
}

let instance: TypingMap | null = null;

export function getTypingMap(): TypingMap {
  if (!instance) instance = new TypingMap();
  return instance;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="TypingMap"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/typing.ts test/typing.test.ts
git commit -m "feat: typing state module"
```

---

### Task 2: Daemon typing routes

**Files:**
- Create: `src/web/routes/typing.ts`
- Modify: `src/web/app.ts:82-94` — add `import typing` and `.route("/api/agents", typing)`

**Step 1: Write the failing test**

Add to `test/typing.test.ts`:

```ts
import { afterEach, beforeEach, describe, it } from "node:test";
import { sessions, users } from "../src/lib/schema.js";
import { createUser } from "../src/lib/auth.js";
import { createSession, deleteSession } from "../src/web/middleware/auth.js";
import { getDb } from "../src/lib/db.js";

describe("typing routes", () => {
  let cookie: string;

  async function cleanup() {
    const db = await getDb();
    await db.delete(sessions);
    await db.delete(users);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("testuser", "pass");
    cookie = await createSession(user.id);
  });

  afterEach(cleanup);

  function headers(method?: "POST") {
    const h: Record<string, string> = { Cookie: `volute_session=${cookie}` };
    if (method === "POST") {
      h["Content-Type"] = "application/json";
      h.Origin = "http://localhost";
    }
    return h;
  }

  it("GET returns empty typing when nobody is typing", async () => {
    const { default: app } = await import("../src/web/app.js");
    const res = await app.request("/api/agents/test/typing?channel=discord:123", {
      headers: headers(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.typing, []);
  });

  it("POST + GET round-trip", async () => {
    const { default: app } = await import("../src/web/app.js");
    const postRes = await app.request("/api/agents/test/typing", {
      method: "POST",
      headers: headers("POST"),
      body: JSON.stringify({ channel: "discord:123", sender: "alice", active: true }),
    });
    assert.equal(postRes.status, 200);

    const getRes = await app.request("/api/agents/test/typing?channel=discord:123", {
      headers: headers(),
    });
    const body = await getRes.json();
    assert.deepEqual(body.typing, ["alice"]);
  });

  it("POST active:false clears sender", async () => {
    const { default: app } = await import("../src/web/app.js");
    await app.request("/api/agents/test/typing", {
      method: "POST",
      headers: headers("POST"),
      body: JSON.stringify({ channel: "discord:123", sender: "alice", active: true }),
    });
    await app.request("/api/agents/test/typing", {
      method: "POST",
      headers: headers("POST"),
      body: JSON.stringify({ channel: "discord:123", sender: "alice", active: false }),
    });

    const res = await app.request("/api/agents/test/typing?channel=discord:123", {
      headers: headers(),
    });
    const body = await res.json();
    assert.deepEqual(body.typing, []);
  });

  it("GET requires channel query param", async () => {
    const { default: app } = await import("../src/web/app.js");
    const res = await app.request("/api/agents/test/typing", {
      headers: headers(),
    });
    assert.equal(res.status, 400);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="typing routes"`
Expected: FAIL — route not found (404)

**Step 3: Write the route**

Create `src/web/routes/typing.ts`:

```ts
import { Hono } from "hono";
import { getTypingMap } from "../../lib/typing.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .post("/:name/typing", async (c) => {
    const body = await c.req.json<{ channel: string; sender: string; active: boolean }>();
    if (!body.channel || !body.sender) {
      return c.json({ error: "channel and sender required" }, 400);
    }
    const map = getTypingMap();
    if (body.active) {
      map.set(body.channel, body.sender);
    } else {
      map.delete(body.channel, body.sender);
    }
    return c.json({ ok: true });
  })
  .get("/:name/typing", (c) => {
    const channel = c.req.query("channel");
    if (!channel) return c.json({ error: "channel query param required" }, 400);
    const map = getTypingMap();
    return c.json({ typing: map.get(channel) });
  });

export default app;
```

Mount in `src/web/app.ts` — add import and `.route("/api/agents", typing)` alongside the other agent routes.

**Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="typing routes"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/web/routes/typing.ts src/web/app.ts test/typing.test.ts
git commit -m "feat: daemon typing routes"
```

---

### Task 3: Agent turn tracking in message proxy

**Files:**
- Modify: `src/web/routes/agents.ts:237-343` — message proxy handler
- Modify: `src/web/routes/volute/chat.ts:196-276` — chat route

**Step 1: Write the failing test**

Add to `test/typing.test.ts`:

```ts
describe("agent turn tracking", () => {
  // This test verifies the TypingMap integration pattern:
  // set persistent entry, verify it appears, delete it, verify it's gone
  it("persistent entry appears in get and is removed by delete", () => {
    const map = new TypingMap();
    map.set("volute:conv1", "testagent", { persistent: true });
    assert.deepEqual(map.get("volute:conv1"), ["testagent"]);
    map.delete("volute:conv1", "testagent");
    assert.deepEqual(map.get("volute:conv1"), []);
    map.dispose();
  });
});
```

**Step 2: Run test to verify it fails (should pass immediately since it's a unit test)**

Run: `npm test -- --test-name-pattern="agent turn tracking"`

**Step 3: Modify the message proxy in `agents.ts`**

In the message proxy handler (`.post("/:name/message", ...)`), after the agent responds (fetch returns):

```ts
import { getTypingMap } from "../../lib/typing.js";

// Before streaming the ndjson response:
const typingMap = getTypingMap();
typingMap.set(channel, baseName, { persistent: true });

// In the stream callback, after the for-await loop or in the finally:
typingMap.delete(channel, baseName);
```

Similarly in `chat.ts`, when the primary and secondary agent responses are being consumed:

```ts
// Before consuming responses:
const typingMap = getTypingMap();
for (const agentName of runningAgents) {
  typingMap.set(channel, agentName, { persistent: true });
}

// After primary stream completes:
typingMap.delete(channel, primary.name);

// After each secondary completes (wrap consumeAndPersist):
// typingMap.delete(channel, secondary[i].name);
```

**Step 4: Run all tests**

Run: `npm test`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/web/routes/agents.ts src/web/routes/volute/chat.ts
git commit -m "feat: agent turn tracking in message proxy"
```

---

### Task 4: Message payload enrichment

**Files:**
- Modify: `src/web/routes/agents.ts:237-300` — add `typing` field before forwarding
- Modify: `src/web/routes/volute/chat.ts:186-193` — add `typing` field to payload
- Modify: `src/types.ts:5-15` — add `typing?: string[]` to `ChannelMeta`

**Step 1: Add `typing` to `ChannelMeta`**

In `src/types.ts`, add to `ChannelMeta`:

```ts
export type ChannelMeta = {
  channel?: string;
  sender?: string;
  platform?: string;
  isDM?: boolean;
  channelName?: string;
  serverName?: string;
  sessionName?: string;
  participants?: string[];
  participantCount?: number;
  typing?: string[];
};
```

**Step 2: Enrich payload in agents.ts**

In the message proxy handler, before forwarding to the agent, read typing state and inject it:

```ts
// Before fetch to agent:
const typingMap = getTypingMap();
const currentlyTyping = typingMap.get(channel);

// When building the body to forward, parse it and add typing:
if (parsed && currentlyTyping.length > 0) {
  parsed.typing = currentlyTyping;
}
// Re-stringify the body with typing included
```

**Step 3: Enrich payload in chat.ts**

In the chat route, add typing to the payload before sending to agents:

```ts
const typingMap = getTypingMap();
const currentlyTyping = typingMap.get(channel);

const payload = JSON.stringify({
  content: contentBlocks,
  channel,
  sender: senderName,
  participants: participantNames,
  participantCount: participants.length,
  isDM,
  ...(currentlyTyping.length > 0 ? { typing: currentlyTyping } : {}),
});
```

**Step 4: Run all tests**

Run: `npm test`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/types.ts src/web/routes/agents.ts src/web/routes/volute/chat.ts
git commit -m "feat: enrich message payloads with typing state"
```

---

### Task 5: Agent template typing display

**Files:**
- Modify: `templates/_base/src/lib/types.ts:5-15` — add `typing?: string[]` to `ChannelMeta`
- Modify: `templates/_base/src/lib/router.ts:115-167` — append typing line after batch body
- Modify: `templates/_base/src/lib/format-prefix.ts` — add typing suffix helper

**Step 1: Add `typing` to template's `ChannelMeta`**

In `templates/_base/src/lib/types.ts`, add `typing?: string[]` to `ChannelMeta` (mirrors daemon `src/types.ts`).

**Step 2: Add typing suffix to format-prefix.ts**

In `templates/_base/src/lib/format-prefix.ts`:

```ts
export function formatTypingSuffix(typing: string[] | undefined): string {
  if (!typing || typing.length === 0) return "";
  if (typing.length === 1) return `\n[${typing[0]} is typing]`;
  return `\n[${typing.join(", ")} are typing]`;
}
```

**Step 3: Append typing suffix in router.ts**

In the `flushBatch` function in `templates/_base/src/lib/router.ts`, after building the batch body text, append the typing suffix. The batch handler receives `meta` but batch mode currently doesn't propagate `typing`. The typing state should be fetched at flush time — but the batch buffer doesn't have access to the daemon. Instead, the typing info comes from the most recent message's metadata.

For direct dispatch (non-batch), append typing suffix in `applyPrefix`:

```ts
function applyPrefix(content: VoluteContentPart[], meta: ChannelMeta): VoluteContentPart[] {
  const time = new Date().toLocaleString();
  const prefix = formatPrefix(meta, time);
  const typingSuffix = formatTypingSuffix(meta.typing);
  // ... existing logic, then append typingSuffix to the last text block
}
```

For batch mode, append typing suffix after the body in `flushBatch`. The `BufferedMessage` type needs a `typing` field, populated from the last message in the batch.

**Step 4: Run all tests**

Run: `npm test`
Expected: All PASS

**Step 5: Commit**

```bash
git add templates/_base/src/lib/types.ts templates/_base/src/lib/format-prefix.ts templates/_base/src/lib/router.ts
git commit -m "feat: display typing indicators in agent message prefix"
```

---

### Task 6: Discord connector typing observation

**Files:**
- Modify: `src/connectors/discord.ts:34-42` — add typing intents
- Modify: `src/connectors/discord.ts` — add `typingStart` event listener
- Modify: `src/connectors/sdk.ts` — add typing report helper to SDK

**Step 1: Add typing intents**

In `src/connectors/discord.ts`, add to the `Client` constructor intents:

```ts
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [Partials.Channel],
});
```

**Step 2: Add typing report helper to SDK**

In `src/connectors/sdk.ts`, add:

```ts
export function reportTyping(
  env: ConnectorEnv,
  channel: string,
  sender: string,
  active: boolean,
): void {
  fetch(`${env.baseUrl}/typing`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify({ channel, sender, active }),
  }).catch(() => {});
}
```

**Step 3: Add typingStart listener**

In `src/connectors/discord.ts`, after the `ClientReady` handler:

```ts
client.on(Events.TypingStart, (typing) => {
  if (typing.user.bot) return;
  const sender = typing.member?.displayName || typing.user.username;
  reportTyping(env, `discord:${typing.channel.id}`, sender, true);
});
```

**Step 4: Run all tests**

Run: `npm test`
Expected: All PASS (connector tests are structural, not integration)

**Step 5: Commit**

```bash
git add src/connectors/discord.ts src/connectors/sdk.ts
git commit -m "feat: discord connector forwards typing indicators"
```

---

### Task 7: CLI typing command

**Files:**
- Modify: `src/commands/channel.ts` — add `typing` subcommand and update usage

**Step 1: Add the subcommand**

In `src/commands/channel.ts`, add case `"typing"` to the switch and implement:

```ts
case "typing":
  await typingChannel(args.slice(1));
  break;
```

```ts
async function typingChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel typing <channel-uri> [--agent <name>]");
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);

  try {
    const res = await daemonFetch(
      `/api/agents/${encodeURIComponent(agentName)}/typing?channel=${encodeURIComponent(uri)}`,
    );
    const data = (await res.json()) as { typing: string[] };
    if (data.typing.length === 0) {
      // No output — agent can check exit code or empty output
      return;
    }
    for (const sender of data.typing) {
      console.log(`${sender} is typing`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
```

Update `printUsage` to include the new subcommand.

**Step 2: Run all tests**

Run: `npm test`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/commands/channel.ts
git commit -m "feat: volute channel typing CLI command"
```

---

### Task 8: Volute web frontend typing reporter

**Files:**
- Modify: `src/web/frontend/src/components/Chat.tsx` — add typing reporter + display
- Modify: `src/web/frontend/src/lib/api.ts` — add typing API functions

**Step 1: Add typing API functions**

In `src/web/frontend/src/lib/api.ts`:

```ts
export async function reportTyping(
  agentName: string,
  channel: string,
  sender: string,
  active: boolean,
): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(agentName)}/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, sender, active }),
  });
}

export async function fetchTyping(agentName: string, channel: string): Promise<string[]> {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentName)}/typing?channel=${encodeURIComponent(channel)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { typing: string[] };
  return data.typing;
}
```

**Step 2: Add typing reporter to Chat component**

In `Chat.tsx`, add a debounced typing reporter that fires on input change:

- Use a `useRef` to track last report time (debounce to every 3s)
- On input change, if text is non-empty and 3s since last report, POST active:true
- On send or blur, POST active:false
- On component unmount with pending typing, POST active:false

**Step 3: Add typing indicator display**

- Poll `fetchTyping` every 3s when there's a conversation and not streaming
- Display a typing indicator below the messages area, above the input:
  ```
  alice is typing...
  ```
- Filter out the current user's name from the typing list
- Use the same pulsing animation style as the existing "thinking..." text

**Step 4: Build frontend**

Run: `npm run build` (or `npm run dev:web` for dev mode)
Expected: Builds without errors

**Step 5: Commit**

```bash
git add src/web/frontend/src/components/Chat.tsx src/web/frontend/src/lib/api.ts
git commit -m "feat: web frontend typing indicators"
```

---

### Task 9: Manual testing & cleanup

**Step 1: Run full test suite**

Run: `npm test`
Expected: All PASS

**Step 2: Build**

Run: `npm run build`
Expected: Clean build

**Step 3: Manual verification (if possible)**

- Start daemon with `volute up`
- Open web dashboard, start chatting — verify typing indicator shows when typing
- If Discord connector is available, verify typing events are forwarded
- Test `volute channel typing` CLI command

**Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: typing indicators cleanup"
```
