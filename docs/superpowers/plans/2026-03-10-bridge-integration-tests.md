# Bridge System Integration Tests

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daemon-level integration tests that verify the full bridge + chat system works end-to-end, covering volute-internal conversations, the bridge API, puppet users, inbound/outbound message flow, and (with operator assistance) live Discord bridging.

**Architecture:** Extend `test/daemon-e2e.test.ts` with new test suites that exercise the bridge and chat APIs against a running daemon. Tests are split into two groups: (1) fully automated tests for volute-internal chat and bridge config management, and (2) semi-automated tests for live Discord bridging that require operator interaction.

**Tech Stack:** Node.js test runner, daemon HTTP API, existing test patterns from `test/daemon-e2e.test.ts`

---

## Chunk 1: Automated Chat & Bridge Tests

### File Structure

| File | Responsibility |
|------|---------------|
| `test/daemon-e2e.test.ts` | Extend with bridge + chat integration tests |

All tests go in the existing `test/daemon-e2e.test.ts` file to reuse its daemon lifecycle (before/after hooks, port allocation, auth helpers). The daemon is already started by the existing `before()` hook and a test mind (`e2e-test-mind`) is created by the existing lifecycle test.

### Task 1: Volute Channel CRUD

Tests creating channels, joining them, listing them, and verifying the full lifecycle through the daemon API.

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

Add after the existing daemon e2e tests (inside the `describe("daemon e2e", ...)` block):

```typescript
it("volute channels: create, join, list, leave", async () => {
  // Create a channel
  const createRes = await daemonRequest("/api/volute/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-bridge-channel" }),
  });
  assert.equal(createRes.status, 201);
  const { id: channelId } = (await createRes.json()) as { id: string };
  assert.ok(channelId);

  // List channels — should include the new one
  const listRes = await daemonRequest("/api/volute/channels");
  assert.equal(listRes.status, 200);
  const channels = (await listRes.json()) as { name: string; id: string }[];
  assert.ok(channels.some((ch) => ch.name === "test-bridge-channel"));

  // Join channel
  const joinRes = await daemonRequest("/api/volute/channels/test-bridge-channel/join", {
    method: "POST",
  });
  assert.equal(joinRes.status, 200);

  // List members
  const membersRes = await daemonRequest("/api/volute/channels/test-bridge-channel/members");
  assert.equal(membersRes.status, 200);
  const members = (await membersRes.json()) as { username: string }[];
  assert.ok(members.length >= 1);

  // Leave channel
  const leaveRes = await daemonRequest("/api/volute/channels/test-bridge-channel/leave", {
    method: "POST",
  });
  assert.equal(leaveRes.status, 200);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "volute channels"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add volute channel CRUD integration test"
```

### Task 2: Conversation Lifecycle (Create, Send, Read)

Tests creating a conversation with participants, sending messages through the chat API, and reading them back.

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("conversations: create, send message, read back", async () => {
  // Create a conversation via the minds API
  // First, the test mind needs to exist (created by earlier lifecycle test)
  const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "e2e test conversation",
      participantNames: [],
    }),
  });
  assert.equal(createRes.status, 200, `Create conv: ${await createRes.clone().text()}`);
  const { id: convId } = (await createRes.json()) as { id: string };
  assert.ok(convId);

  // Send a message via the per-mind chat endpoint
  const chatRes = await daemonRequest(`/api/minds/${TEST_MIND}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: convId,
      content: [{ type: "text", text: "hello from integration test" }],
    }),
  });
  assert.equal(chatRes.status, 200, `Chat: ${await chatRes.clone().text()}`);

  // Read messages back
  const msgsRes = await daemonRequest(
    `/api/minds/${TEST_MIND}/conversations/${convId}/messages`,
  );
  assert.equal(msgsRes.status, 200);
  const { messages } = (await msgsRes.json()) as {
    messages: { content: string | { type: string; text?: string }[]; sender_name: string }[];
  };
  assert.ok(messages.length >= 1);
  const lastMsg = messages[messages.length - 1];
  const text = Array.isArray(lastMsg.content)
    ? lastMsg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
    : lastMsg.content;
  assert.ok(text.includes("hello from integration test"), `Message text: ${text}`);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "conversations: create"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add conversation lifecycle integration test"
```

### Task 3: Unified Chat Endpoint

Tests the unified `/api/volute/chat` endpoint (the one used by the web dashboard).

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("unified chat: send via /api/volute/chat", async () => {
  // Create a conversation first
  const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "unified chat test",
      participantNames: [],
    }),
  });
  assert.equal(createRes.status, 200);
  const { id: convId } = (await createRes.json()) as { id: string };

  // Send via unified endpoint
  const chatRes = await daemonRequest("/api/volute/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: convId,
      content: [{ type: "text", text: "unified endpoint test" }],
    }),
  });
  assert.equal(chatRes.status, 200, `Unified chat: ${await chatRes.clone().text()}`);

  // Read it back
  const msgsRes = await daemonRequest(
    `/api/minds/${TEST_MIND}/conversations/${convId}/messages`,
  );
  assert.equal(msgsRes.status, 200);
  const { messages } = (await msgsRes.json()) as {
    messages: { content: string | { type: string; text?: string }[] }[];
  };
  assert.ok(messages.length >= 1);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "unified chat"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add unified chat endpoint integration test"
```

### Task 4: Bridge Config Management API

Tests the bridge CRUD API — enabling, disabling, listing, channel mappings. Does NOT start an actual bridge process (no Discord token needed).

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("bridge config: list, mappings CRUD", async () => {
  // List bridges — initially empty (or whatever is configured)
  const listRes = await daemonRequest("/api/bridges");
  assert.equal(listRes.status, 200);
  const bridges = (await listRes.json()) as { platform: string }[];
  const hadDiscord = bridges.some((b) => b.platform === "discord");

  // Set a channel mapping (this works even without an enabled bridge)
  // First we need to enable a bridge config manually via the config file
  // Use the API — it will fail if env vars are missing, which is expected
  // Instead, test mapping CRUD via direct config write + API read
  const { setBridgeConfig, removeBridgeConfig } = await import(
    "../src/lib/bridges.js"
  );
  setBridgeConfig("test-platform", {
    enabled: false,
    defaultMind: TEST_MIND,
    channelMappings: {},
  });

  // Add mapping via API
  const mapRes = await daemonRequest("/api/bridges/test-platform/mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalChannel: "server/general",
      voluteChannel: "test-bridge-channel",
    }),
  });
  assert.equal(mapRes.status, 200);

  // Read mappings
  const mappingsRes = await daemonRequest("/api/bridges/test-platform/mappings");
  assert.equal(mappingsRes.status, 200);
  const mappings = (await mappingsRes.json()) as Record<string, string>;
  assert.equal(mappings["server/general"], "test-bridge-channel");

  // Remove mapping
  const unmapRes = await daemonRequest(
    `/api/bridges/test-platform/mappings/${encodeURIComponent("server/general")}`,
    { method: "DELETE" },
  );
  assert.equal(unmapRes.status, 200);

  // Verify removed
  const afterRes = await daemonRequest("/api/bridges/test-platform/mappings");
  const afterMappings = (await afterRes.json()) as Record<string, string>;
  assert.equal(afterMappings["server/general"], undefined);

  // List bridges — should include test-platform now
  const listRes2 = await daemonRequest("/api/bridges");
  assert.equal(listRes2.status, 200);
  const bridges2 = (await listRes2.json()) as { platform: string; enabled: boolean }[];
  assert.ok(bridges2.some((b) => b.platform === "test-platform" && !b.enabled));

  // Clean up
  removeBridgeConfig("test-platform");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "bridge config"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add bridge config management integration test"
```

### Task 5: Bridge Inbound — Puppet Users + Channel Messages

Tests the full inbound bridge flow: an external message arrives via the bridge inbound API, a puppet user is created, the message lands in a mapped Volute channel.

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("bridge inbound: puppet user created, message lands in channel", async () => {
  const { setBridgeConfig, removeBridgeConfig } = await import(
    "../src/lib/bridges.js"
  );

  // Set up a bridge with a mapping to the channel we created earlier
  setBridgeConfig("test-inbound", {
    enabled: true,
    defaultMind: TEST_MIND,
    channelMappings: { "server/general": "test-bridge-channel" },
  });

  // Send an inbound message (requires daemon token auth — id === 0)
  const inboundRes = await fetch(`${BASE_URL}/api/bridges/test-inbound/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({
      content: [{ type: "text", text: "hello from discord!" }],
      platformUserId: "alice123",
      displayName: "Alice",
      externalChannel: "server/general",
      isDM: false,
    }),
  });
  assert.equal(inboundRes.status, 200, `Inbound: ${await inboundRes.clone().text()}`);
  const inboundBody = (await inboundRes.json()) as { ok: boolean; conversationId?: string };
  assert.equal(inboundBody.ok, true);
  assert.ok(inboundBody.conversationId, "Should return a conversation ID");

  // Verify puppet user was created by checking conversation participants
  const participantsRes = await daemonRequest(
    `/api/minds/${TEST_MIND}/conversations/${inboundBody.conversationId}/participants`,
  );
  if (participantsRes.status === 200) {
    const participants = (await participantsRes.json()) as {
      username: string;
      userType?: string;
    }[];
    assert.ok(
      participants.some(
        (p) => p.username === "test-inbound:alice123" || p.username?.includes("alice"),
      ),
      `Expected puppet user in participants: ${JSON.stringify(participants)}`,
    );
  }

  // Read the message back from the conversation
  const msgsRes = await daemonRequest(
    `/api/minds/${TEST_MIND}/conversations/${inboundBody.conversationId}/messages`,
  );
  assert.equal(msgsRes.status, 200);
  const { messages } = (await msgsRes.json()) as {
    messages: { content: string | { type: string; text?: string }[]; sender_name: string }[];
  };
  const bridgedMsg = messages.find((m) => m.sender_name === "Alice");
  assert.ok(bridgedMsg, `Expected message from Alice, got: ${JSON.stringify(messages)}`);

  // Clean up
  removeBridgeConfig("test-inbound");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "bridge inbound"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add bridge inbound integration test with puppet users"
```

### Task 6: Bridge Inbound — DM Routing

Tests that DMs from external users get routed to the default mind.

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("bridge inbound: DM creates conversation with default mind", async () => {
  const { setBridgeConfig, removeBridgeConfig } = await import(
    "../src/lib/bridges.js"
  );

  setBridgeConfig("test-dm", {
    enabled: true,
    defaultMind: TEST_MIND,
    channelMappings: {},
  });

  // Send a DM via inbound
  const inboundRes = await fetch(`${BASE_URL}/api/bridges/test-dm/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({
      content: [{ type: "text", text: "hey, this is a DM" }],
      platformUserId: "bob456",
      displayName: "Bob",
      externalChannel: "@bob",
      isDM: true,
    }),
  });
  assert.equal(inboundRes.status, 200);
  const body = (await inboundRes.json()) as { ok: boolean; conversationId?: string };
  assert.equal(body.ok, true);
  assert.ok(body.conversationId);

  // Send a second DM from the same user — should reuse the conversation
  const secondRes = await fetch(`${BASE_URL}/api/bridges/test-dm/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({
      content: [{ type: "text", text: "second message" }],
      platformUserId: "bob456",
      displayName: "Bob",
      externalChannel: "@bob",
      isDM: true,
    }),
  });
  assert.equal(secondRes.status, 200);
  const body2 = (await secondRes.json()) as { ok: boolean; conversationId?: string };
  assert.equal(body2.conversationId, body.conversationId, "Should reuse same DM conversation");

  // Verify both messages are in the conversation
  const msgsRes = await daemonRequest(
    `/api/minds/${TEST_MIND}/conversations/${body.conversationId}/messages`,
  );
  assert.equal(msgsRes.status, 200);
  const { messages } = (await msgsRes.json()) as {
    messages: { sender_name: string }[];
  };
  const bobMsgs = messages.filter((m) => m.sender_name === "Bob");
  assert.ok(bobMsgs.length >= 2, `Expected 2+ messages from Bob, got ${bobMsgs.length}`);

  // Clean up
  removeBridgeConfig("test-dm");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "bridge inbound: DM"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add bridge DM routing integration test"
```

### Task 7: Bridge Enable/Disable with Missing Env

Tests that enabling a bridge returns a clear error when required env vars are missing.

**Files:**
- Modify: `test/daemon-e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it("bridge enable: returns missing_env when credentials not set", async () => {
  // Try to enable discord bridge without DISCORD_TOKEN
  const enableRes = await daemonRequest("/api/bridges/discord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultMind: TEST_MIND }),
  });
  // Should fail with missing_env error
  assert.equal(enableRes.status, 400);
  const body = (await enableRes.json()) as { error: string; missing?: { name: string }[] };
  assert.equal(body.error, "missing_env");
  assert.ok(Array.isArray(body.missing));
  assert.ok(body.missing.some((v) => v.name === "DISCORD_TOKEN"));
});

it("bridge disable: delete removes config", async () => {
  const { setBridgeConfig, getBridgeConfig } = await import(
    "../src/lib/bridges.js"
  );

  // Set up a fake bridge
  setBridgeConfig("test-disable", {
    enabled: true,
    defaultMind: TEST_MIND,
    channelMappings: {},
  });

  // Delete it
  const delRes = await daemonRequest("/api/bridges/test-disable", { method: "DELETE" });
  assert.equal(delRes.status, 200);

  // Verify it's gone
  const config = getBridgeConfig("test-disable");
  assert.equal(config, undefined);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "bridge enable|bridge disable"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/daemon-e2e.test.ts
git commit -m "test: add bridge enable/disable integration tests"
```

## Chunk 2: Live Discord Bridge Test (Semi-Automated)

This chunk creates a test script that exercises the live Discord bridge. It requires operator interaction — the operator sends a message on Discord and verifies it appears in Volute.

### Task 8: Live Discord Bridge Test Script

This is a standalone script (not part of `npm test`) that:
1. Reads DISCORD_TOKEN from `~/.volute/system/env.json`
2. Enables the Discord bridge via the API
3. Maps a Discord channel to a Volute channel
4. Waits for the operator to send a message on Discord
5. Checks that the message appeared in the Volute conversation
6. Cleans up

**Files:**
- Create: `test/bridge-discord-live.ts`

- [ ] **Step 1: Write the test script**

```typescript
/**
 * Live Discord bridge integration test.
 *
 * Prerequisites:
 *   - Daemon running (`volute up`)
 *   - DISCORD_TOKEN set in ~/.volute/system/env.json
 *
 * Usage:
 *   npx tsx test/bridge-discord-live.ts --channel "server/channel" --volute-channel "test-channel"
 *
 * The script will:
 *   1. Create a Volute channel
 *   2. Enable the Discord bridge
 *   3. Map the Discord channel to the Volute channel
 *   4. Wait for you to send a message on Discord in that channel
 *   5. Verify the message appears in the Volute conversation
 *   6. Clean up
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const discordChannel = getArg("channel");
const voluteChannelName = getArg("volute-channel") ?? "bridge-test";
const mindName = getArg("mind") ?? "luna"; // default mind for DM routing

if (!discordChannel) {
  console.error(
    'Usage: npx tsx test/bridge-discord-live.ts --channel "server/channel" [--volute-channel name] [--mind name]',
  );
  process.exit(1);
}

// Read daemon config
const systemDir = resolve(homedir(), ".volute/system");
const daemonPath = resolve(systemDir, "daemon.json");
if (!existsSync(daemonPath)) {
  console.error("Daemon not running — start with `volute up`");
  process.exit(1);
}
const daemonConfig = JSON.parse(readFileSync(daemonPath, "utf-8"));
const { port, token } = daemonConfig;
const BASE = `http://127.0.0.1:${port}`;

async function api(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Origin", BASE);
  return fetch(`${BASE}${path}`, { ...options, headers });
}

async function main() {
  console.log("=== Live Discord Bridge Test ===\n");

  // Step 1: Check Discord token
  const envPath = resolve(systemDir, "env.json");
  if (!existsSync(envPath)) {
    console.error("No env.json found — set DISCORD_TOKEN with: volute env set DISCORD_TOKEN <token>");
    process.exit(1);
  }
  const env = JSON.parse(readFileSync(envPath, "utf-8"));
  if (!env.DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN not set");
    process.exit(1);
  }
  console.log("✓ DISCORD_TOKEN found");

  // Step 2: Create volute channel
  console.log(`\nCreating volute channel: ${voluteChannelName}`);
  const createRes = await api("/api/volute/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: voluteChannelName }),
  });
  if (createRes.status === 201) {
    console.log("✓ Channel created");
  } else if (createRes.status === 409) {
    console.log("✓ Channel already exists");
  } else {
    console.error(`Failed to create channel: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }

  // Step 3: Enable Discord bridge
  console.log("\nEnabling Discord bridge...");
  const enableRes = await api("/api/bridges/discord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultMind: mindName }),
  });
  if (enableRes.status === 200) {
    console.log("✓ Discord bridge enabled");
  } else {
    const body = await enableRes.json();
    console.error(`Failed to enable bridge:`, body);
    process.exit(1);
  }

  // Step 4: Map Discord channel
  console.log(`\nMapping ${discordChannel} → ${voluteChannelName}`);
  const mapRes = await api("/api/bridges/discord/mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalChannel: discordChannel,
      voluteChannel: voluteChannelName,
    }),
  });
  if (mapRes.status === 200) {
    console.log("✓ Mapping set");
  } else {
    console.error(`Failed to set mapping: ${await mapRes.text()}`);
  }

  // Step 5: Wait for message
  console.log(`\n=== ACTION REQUIRED ===`);
  console.log(`Send a message in Discord channel: ${discordChannel}`);
  console.log(`The message should contain the text: BRIDGE_TEST_${Date.now()}`);
  console.log(`Waiting up to 120 seconds...\n`);

  const marker = `BRIDGE_TEST_${Date.now()}`;
  console.log(`Look for marker text: ${marker}`);
  console.log(`(You can type anything that includes "${marker}")\n`);

  // Poll for the message
  const deadline = Date.now() + 120_000;
  let found = false;
  while (Date.now() < deadline) {
    // Check the volute channel for messages
    const channelsRes = await api("/api/volute/channels");
    const channels = (await channelsRes.json()) as { name: string; id: string }[];
    const ch = channels.find((c) => c.name === voluteChannelName);

    if (ch) {
      // Join channel to read messages
      await api(`/api/volute/channels/${voluteChannelName}/join`, { method: "POST" });

      // Try to read via conversation API
      // Channel conversations need a mind context — use the default mind
      const msgsRes = await api(
        `/api/minds/${mindName}/conversations/${ch.id}/messages?limit=10`,
      );
      if (msgsRes.status === 200) {
        const { messages } = (await msgsRes.json()) as {
          messages: { content: string | { type: string; text?: string }[]; sender_name: string }[];
        };
        for (const msg of messages) {
          const text = Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("")
            : msg.content;
          if (text.includes(marker)) {
            found = true;
            console.log(`✓ Message found from ${msg.sender_name}: "${text}"`);
            break;
          }
        }
      }
    }

    if (found) break;
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(".");
  }

  if (!found) {
    console.log("\n✗ Timed out waiting for message");
  }

  // Step 6: Check bridge list
  console.log("\nBridge status:");
  const bridgesRes = await api("/api/bridges");
  const bridges = (await bridgesRes.json()) as {
    platform: string;
    enabled: boolean;
    running: boolean;
    defaultMind: string;
  }[];
  for (const b of bridges) {
    console.log(`  ${b.platform}: enabled=${b.enabled} running=${b.running} default=${b.defaultMind}`);
  }

  // Cleanup
  console.log("\nCleaning up...");
  await api("/api/bridges/discord", { method: "DELETE" });
  console.log("✓ Discord bridge disabled");

  console.log("\n=== Done ===");
  process.exit(found ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script parses (no runtime test yet)**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add test/bridge-discord-live.ts
git commit -m "test: add live Discord bridge integration test script"
```

### Task 9: Run All Automated Tests

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, including the new bridge/chat integration tests

- [ ] **Step 2: Run the live Discord test (with operator)**

When ready to test the live Discord bridge:

1. Make sure the daemon is running (`volute up`)
2. Ask the operator: "I'm ready to test the Discord bridge. Which Discord channel should I use for the test?"
3. Run: `npx tsx test/bridge-discord-live.ts --channel "<operator-provided-channel>" --mind <operator-provided-mind>`
4. Ask the operator to send a message containing the marker text shown by the script
5. Verify the script exits with code 0

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "test: fix any issues found during live Discord bridge test"
```
