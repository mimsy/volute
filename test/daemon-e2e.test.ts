import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { findMind, mindDir, removeMind, voluteSystemDir } from "../src/lib/registry.js";

// Strip GIT_* env vars that hook runners (e.g. pre-push) inject, so that
// spawned processes (like `volute create` which runs `git init`) don't
// accidentally operate on the parent repo.
const MIND_BASE_PORT = 15100 + Math.floor(Math.random() * 800);
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("GIT_") && v !== undefined) cleanEnv[k] = v;
}
cleanEnv.VOLUTE_BASE_PORT = String(MIND_BASE_PORT);

const TEST_MIND = "e2e-test-mind";
const PORT = 14200 + Math.floor(Math.random() * 800);
const TOKEN = `e2e-test-token-${Date.now()}`;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function daemonRequest(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  headers.set("Origin", BASE_URL);
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon did not become healthy within ${timeoutMs}ms`);
}

describe("daemon e2e", { timeout: 120000 }, () => {
  let daemon: ChildProcess;

  before(async () => {
    // Clean up any leftover test mind
    await cleanupMind();

    // Ensure setup config exists so CLI commands don't fail with "not set up"
    writeFileSync(
      resolve(voluteSystemDir(), "config.json"),
      JSON.stringify({ setup: { type: "local", isolation: "none" } }),
    );

    // Start daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
    });

    // Collect stderr for debugging
    daemon.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[daemon] ${data}`);
    });

    daemon.on("error", (err) => {
      console.error("[daemon] process error:", err);
    });

    await waitForHealth();
  });

  after(async () => {
    // Clean up test mind
    await cleanupMind();

    // Kill daemon
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        daemon.on("exit", () => resolve());
        setTimeout(() => {
          try {
            daemon.kill("SIGKILL");
          } catch {}
          resolve();
        }, 5000);
      });
    }
  });

  async function cleanupMind() {
    try {
      const entry = await findMind(TEST_MIND);
      if (entry) {
        // Kill any orphan process on the mind's port from a previous crashed run
        try {
          const pids = execFileSync("lsof", ["-ti", `:${entry.port}`, "-sTCP:LISTEN"], {
            encoding: "utf-8",
          }).trim();
          for (const pid of pids.split("\n").filter(Boolean)) {
            try {
              process.kill(parseInt(pid, 10), "SIGTERM");
            } catch {}
          }
        } catch {}
        await removeMind(TEST_MIND);
      }
      const dir = mindDir(TEST_MIND);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }

  it("health endpoint returns ok", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("unauthenticated request returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/minds`);
    assert.equal(res.status, 401);
  });

  it("GET /api/minds returns empty array initially", async () => {
    const res = await daemonRequest("/api/minds");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("mind lifecycle: create, start, status, stop", async () => {
    // Create mind via daemon API
    const createRes = await daemonRequest("/api/minds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: TEST_MIND }),
    });
    assert.ok(
      createRes.status === 200 || createRes.status === 201,
      `Create mind: ${createRes.status} ${await createRes.text()}`,
    );

    // Install mind dependencies
    const dir = mindDir(TEST_MIND);
    assert.ok(existsSync(dir), "Mind directory should exist after create");
    execFileSync("npm", ["install"], {
      cwd: dir,
      stdio: "pipe",
      timeout: 60000,
      env: cleanEnv,
    });

    // Re-establish connection after long sync block (keep-alive connections
    // may have been closed by the server while the event loop was blocked)
    await waitForHealth();

    // Verify mind appears in listing
    const listRes = await daemonRequest("/api/minds");
    assert.equal(listRes.status, 200);
    const minds = (await listRes.json()) as Array<{ name: string; status: string }>;
    const testEntry = minds.find((a) => a.name === TEST_MIND);
    assert.ok(testEntry, "Test mind should appear in mind list");
    assert.equal(testEntry.status, "stopped");

    // Start mind
    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    assert.equal(startRes.status, 200, `Start failed: ${await startRes.text()}`);

    // Status should show running
    const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    assert.equal(statusRes.status, 200);
    const mindStatus = (await statusRes.json()) as { name: string; status: string };
    assert.equal(mindStatus.name, TEST_MIND);
    assert.ok(
      mindStatus.status === "running" || mindStatus.status === "starting",
      `Expected running or starting, got ${mindStatus.status}`,
    );

    // Stop mind
    const stopRes = await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);

    // Status should show stopped
    const stoppedRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    assert.equal(stoppedRes.status, 200);
    const stoppedStatus = (await stoppedRes.json()) as { status: string };
    assert.equal(stoppedStatus.status, "stopped");
  });

  it("minds persist running state across daemon restart", async () => {
    // Start mind
    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status}`,
    );

    // Verify running
    const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    const status = (await statusRes.json()) as { status: string };
    assert.ok(
      status.status === "running" || status.status === "starting",
      `Expected running/starting, got ${status.status}`,
    );

    // Kill daemon via SIGTERM (simulates `volute down`)
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      daemon.on("exit", () => resolve());
      setTimeout(() => {
        try {
          daemon.kill("SIGKILL");
        } catch {}
        resolve();
      }, 5000);
    });

    // Registry should still show running: true
    const entry = await findMind(TEST_MIND);
    assert.ok(entry, "Mind should still be in registry");
    assert.equal(entry.running, true, "Mind should still be marked as running in registry");

    // Start a new daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
    });
    daemon.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[daemon] ${data}`);
    });

    await waitForHealth();

    // Mind should be auto-restored by the new daemon
    const deadline = Date.now() + 30000;
    let restored = false;
    while (Date.now() < deadline) {
      const res = await daemonRequest(`/api/minds/${TEST_MIND}`);
      const s = (await res.json()) as { status: string };
      if (s.status === "running") {
        restored = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(restored, "Mind should be auto-restored after daemon restart");

    // Stop mind for subsequent tests
    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
  });

  it("stopped minds stay stopped across daemon restart", async () => {
    // Mind should be stopped from the previous test — verify
    const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    const status = (await statusRes.json()) as { status: string };
    assert.equal(status.status, "stopped", "Mind should be stopped before this test");

    // Verify registry shows running: false
    const entryBefore = await findMind(TEST_MIND);
    assert.ok(entryBefore, "Mind should be in registry");
    assert.equal(entryBefore.running, false, "Mind should be marked as not running in registry");

    // Kill daemon via SIGTERM
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      daemon.on("exit", () => resolve());
      setTimeout(() => {
        try {
          daemon.kill("SIGKILL");
        } catch {}
        resolve();
      }, 5000);
    });

    // Registry should still show running: false
    const entryAfter = await findMind(TEST_MIND);
    assert.ok(entryAfter, "Mind should still be in registry");
    assert.equal(entryAfter.running, false, "Stopped mind should remain not running in registry");

    // Start a new daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
    });
    daemon.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[daemon] ${data}`);
    });

    await waitForHealth();

    // Mind should still be stopped — not auto-started
    const restoredRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    const restoredStatus = (await restoredRes.json()) as { status: string };
    assert.equal(
      restoredStatus.status,
      "stopped",
      "Stopped mind should not be auto-started after daemon restart",
    );
  });

  // ── Bridge & Chat Integration Tests ──

  /** Ensure the test mind exists in the registry (creates via API if not). */
  async function ensureTestMind(): Promise<void> {
    const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    if (statusRes.status === 200) return; // already exists

    const createRes = await daemonRequest("/api/minds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: TEST_MIND }),
    });
    assert.ok(
      createRes.status === 200 || createRes.status === 201 || createRes.status === 409,
      `Failed to create test mind: ${createRes.status} ${await createRes.text()}`,
    );
  }

  it("volute channels: create, list, invite mind, members", async () => {
    await ensureTestMind();

    // Create a channel
    const createRes = await daemonRequest("/api/volute/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-bridge-channel" }),
    });
    assert.equal(createRes.status, 201, `Create: ${await createRes.clone().text()}`);
    const created = (await createRes.json()) as { id: string; name: string };
    assert.ok(created.id);

    // List channels — should include the new one
    const listRes = await daemonRequest("/api/volute/channels");
    assert.equal(listRes.status, 200);
    const channels = (await listRes.json()) as { name: string; id: string }[];
    assert.ok(channels.some((ch) => ch.name === "test-bridge-channel"));

    // Invite the test mind to the channel
    const inviteRes = await daemonRequest("/api/volute/channels/test-bridge-channel/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: TEST_MIND }),
    });
    assert.equal(inviteRes.status, 200, `Invite: ${await inviteRes.clone().text()}`);

    // List members — should include the mind
    const membersRes = await daemonRequest("/api/volute/channels/test-bridge-channel/members");
    assert.equal(membersRes.status, 200);
    const members = (await membersRes.json()) as { username: string }[];
    assert.ok(
      members.some((m) => m.username === TEST_MIND),
      `Expected ${TEST_MIND} in members: ${JSON.stringify(members)}`,
    );
  });

  it("conversations: create, send message, read back", async () => {
    await ensureTestMind();

    // Create a conversation with the test mind
    const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "e2e test conversation",
        participantNames: [TEST_MIND],
      }),
    });
    assert.equal(createRes.status, 201, `Create conv: ${await createRes.clone().text()}`);
    const conv = (await createRes.json()) as { id: string };
    assert.ok(conv.id);

    // Send a message via the per-mind chat endpoint
    const chatRes = await daemonRequest(`/api/minds/${TEST_MIND}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conv.id,
        message: "hello from integration test",
      }),
    });
    assert.equal(chatRes.status, 200, `Chat: ${await chatRes.clone().text()}`);

    // Read messages back
    const msgsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${conv.id}/messages`,
    );
    assert.equal(msgsRes.status, 200);
    const messages = (await msgsRes.json()) as {
      content: { type: string; text?: string }[];
      sender_name: string;
    }[];
    assert.ok(messages.length >= 1);
    const lastMsg = messages[messages.length - 1];
    const text = lastMsg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    assert.ok(text.includes("hello from integration test"), `Message text: ${text}`);
  });

  it("unified chat: send via /api/volute/chat", async () => {
    // Create a conversation first
    const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "unified chat test",
        participantNames: [TEST_MIND],
      }),
    });
    assert.equal(createRes.status, 201, `Create: ${await createRes.clone().text()}`);
    const conv = (await createRes.json()) as { id: string };

    // Send via unified endpoint
    const chatRes = await daemonRequest("/api/volute/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conv.id,
        message: "unified endpoint test",
      }),
    });
    assert.equal(chatRes.status, 200, `Unified chat: ${await chatRes.clone().text()}`);

    // Read it back
    const msgsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${conv.id}/messages`,
    );
    assert.equal(msgsRes.status, 200);
    const messages = (await msgsRes.json()) as { content: { type: string; text?: string }[] }[];
    assert.ok(messages.length >= 1);
  });

  it("bridge config: set, mappings CRUD, remove", async () => {
    const { setBridgeConfig, removeBridgeConfig } = await import("../src/lib/bridges.js");

    // Set up a test bridge config directly
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
    assert.equal(mapRes.status, 200, `Map: ${await mapRes.clone().text()}`);

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

    // List bridges — should include test-platform
    const listRes = await daemonRequest("/api/bridges");
    assert.equal(listRes.status, 200);
    const bridges = (await listRes.json()) as { platform: string; enabled: boolean }[];
    assert.ok(
      bridges.some((b) => b.platform === "test-platform" && !b.enabled),
      `Expected test-platform in bridges: ${JSON.stringify(bridges)}`,
    );

    // Clean up
    removeBridgeConfig("test-platform");
  });

  it("bridge inbound: puppet user created, message lands in channel", async () => {
    const { setBridgeConfig, removeBridgeConfig } = await import("../src/lib/bridges.js");

    // Set up a bridge with a mapping to the channel we created earlier
    setBridgeConfig("test-inbound", {
      enabled: true,
      defaultMind: TEST_MIND,
      channelMappings: { "server/general": "test-bridge-channel" },
    });

    // Send an inbound message (daemon token auth — user.id === 0)
    const inboundRes = await daemonRequest("/api/bridges/test-inbound/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    // Verify puppet user in participants
    const participantsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${inboundBody.conversationId}/participants`,
    );
    assert.equal(participantsRes.status, 200);
    const participants = (await participantsRes.json()) as {
      username: string;
      userType?: string;
    }[];
    assert.ok(
      participants.some((p) => p.username?.includes("alice")),
      `Expected puppet user in participants: ${JSON.stringify(participants)}`,
    );

    // Read the message back from the conversation
    const msgsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${inboundBody.conversationId}/messages`,
    );
    assert.equal(msgsRes.status, 200);
    const messages = (await msgsRes.json()) as {
      content: { type: string; text?: string }[];
      sender_name: string;
    }[];
    const bridgedMsg = messages.find((m) => m.sender_name === "Alice");
    assert.ok(bridgedMsg, `Expected message from Alice, got: ${JSON.stringify(messages)}`);

    // Clean up
    removeBridgeConfig("test-inbound");
  });

  it("bridge inbound: DM creates conversation with default mind", async () => {
    await ensureTestMind();
    const { setBridgeConfig, removeBridgeConfig } = await import("../src/lib/bridges.js");

    setBridgeConfig("test-dm", {
      enabled: true,
      defaultMind: TEST_MIND,
      channelMappings: {},
    });

    // Send a DM via inbound
    const inboundRes = await daemonRequest("/api/bridges/test-dm/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "hey, this is a DM" }],
        platformUserId: "bob456",
        displayName: "Bob",
        externalChannel: "@bob",
        isDM: true,
      }),
    });
    assert.equal(inboundRes.status, 200);
    const body1 = (await inboundRes.json()) as { ok: boolean; conversationId?: string };
    assert.equal(body1.ok, true);
    assert.ok(body1.conversationId);

    // Send a second DM from the same user — should reuse the conversation
    const secondRes = await daemonRequest("/api/bridges/test-dm/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    assert.equal(body2.conversationId, body1.conversationId, "Should reuse same DM conversation");

    // Verify both messages are in the conversation
    const msgsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${body1.conversationId}/messages`,
    );
    assert.equal(msgsRes.status, 200);
    const messages = (await msgsRes.json()) as { sender_name: string }[];
    const bobMsgs = messages.filter((m) => m.sender_name === "Bob");
    assert.ok(bobMsgs.length >= 2, `Expected 2+ messages from Bob, got ${bobMsgs.length}`);

    // Clean up
    removeBridgeConfig("test-dm");
  });

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
    const { setBridgeConfig, getBridgeConfig } = await import("../src/lib/bridges.js");

    // Set up a fake bridge
    setBridgeConfig("test-disable", {
      enabled: true,
      defaultMind: TEST_MIND,
      channelMappings: {},
    });

    // Delete it via API
    const delRes = await daemonRequest("/api/bridges/test-disable", { method: "DELETE" });
    assert.equal(delRes.status, 200);

    // Verify it's gone (getBridgeConfig returns null for missing configs)
    const config = getBridgeConfig("test-disable");
    assert.equal(config, null);
  });

  // ── End Bridge & Chat Tests ──

  // ── Clock & Schedule Integration Tests ──

  it("schedule CRUD: add cron schedule, list, update, remove", async () => {
    await ensureTestMind();

    // Add a cron schedule
    const addRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 9 * * *", message: "good morning", id: "test-cron" }),
    });
    assert.equal(addRes.status, 201, `Add schedule: ${await addRes.clone().text()}`);

    // List — should include the schedule
    const listRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    assert.equal(listRes.status, 200);
    const schedules = (await listRes.json()) as { id: string; cron?: string; message?: string }[];
    const found = schedules.find((s) => s.id === "test-cron");
    assert.ok(found, `Expected test-cron in schedules: ${JSON.stringify(schedules)}`);
    assert.equal(found.cron, "0 9 * * *");
    assert.equal(found.message, "good morning");

    // Update message
    const updateRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "updated message" }),
    });
    assert.equal(updateRes.status, 200, `Update: ${await updateRes.clone().text()}`);

    // Verify update
    const listRes2 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    const schedules2 = (await listRes2.json()) as { id: string; message?: string }[];
    assert.equal(schedules2.find((s) => s.id === "test-cron")?.message, "updated message");

    // Delete
    const delRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-cron`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);

    // Verify deleted
    const listRes3 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    const schedules3 = (await listRes3.json()) as { id: string }[];
    assert.ok(!schedules3.some((s) => s.id === "test-cron"), "Schedule should be removed");
  });

  it("schedule: add fireAt timer", async () => {
    await ensureTestMind();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const addRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fireAt: futureISO, message: "timer test", id: "test-timer" }),
    });
    assert.equal(addRes.status, 201, `Add timer: ${await addRes.clone().text()}`);

    // Verify it shows up with fireAt
    const listRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    const schedules = (await listRes.json()) as { id: string; fireAt?: string }[];
    const timer = schedules.find((s) => s.id === "test-timer");
    assert.ok(timer, "Timer should exist");
    assert.equal(timer.fireAt, futureISO);

    // Clean up
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-timer`, { method: "DELETE" });
  });

  it("schedule: whileSleeping field", async () => {
    await ensureTestMind();

    const addRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cron: "0 3 * * *",
        message: "dream",
        id: "test-sleep-sched",
        whileSleeping: "trigger-wake",
        channel: "system:dream",
      }),
    });
    assert.equal(addRes.status, 201, `Add: ${await addRes.clone().text()}`);

    // Verify fields
    const listRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    const schedules = (await listRes.json()) as {
      id: string;
      whileSleeping?: string;
      channel?: string;
    }[];
    const sched = schedules.find((s) => s.id === "test-sleep-sched");
    assert.ok(sched);
    assert.equal(sched.whileSleeping, "trigger-wake");
    assert.equal(sched.channel, "system:dream");

    // Update whileSleeping
    const updateRes = await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-sleep-sched`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whileSleeping: "skip" }),
    });
    assert.equal(updateRes.status, 200);

    const listRes2 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`);
    const schedules2 = (await listRes2.json()) as { id: string; whileSleeping?: string }[];
    assert.equal(schedules2.find((s) => s.id === "test-sleep-sched")?.whileSleeping, "skip");

    // Clean up
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-sleep-sched`, { method: "DELETE" });
  });

  it("clock status endpoint", async () => {
    await ensureTestMind();

    // Add a schedule so there's something in the response
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 9 * * *", message: "status test", id: "test-status" }),
    });

    const res = await daemonRequest(`/api/minds/${TEST_MIND}/clock/status`);
    assert.equal(res.status, 200, `Clock status: ${await res.clone().text()}`);

    const body = (await res.json()) as {
      sleep: unknown;
      sleepConfig: unknown;
      schedules: { id: string }[];
      upcoming: { id: string; at: string; type: string }[];
    };
    assert.ok(Array.isArray(body.schedules), "schedules should be an array");
    assert.ok(Array.isArray(body.upcoming), "upcoming should be an array");
    assert.ok(
      body.schedules.some((s) => s.id === "test-status"),
      `Expected test-status in schedules: ${JSON.stringify(body.schedules)}`,
    );

    // upcoming should include the cron schedule's next fire
    const upcomingEntry = body.upcoming.find((u) => u.id === "test-status");
    assert.ok(upcomingEntry, "Cron schedule should appear in upcoming");
    assert.equal(upcomingEntry.type, "cron");
    assert.ok(upcomingEntry.at, "Should have a fire time");

    // Clean up
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules/test-status`, { method: "DELETE" });
  });

  it("schedule validation errors", async () => {
    await ensureTestMind();

    // No id
    const r0 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 9 * * *", message: "no id" }),
    });
    assert.equal(r0.status, 400);

    // No cron or fireAt
    const r1 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "val-test-1", message: "no trigger" }),
    });
    assert.equal(r1.status, 400);

    // Both cron and fireAt
    const r2 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "val-test-2",
        cron: "0 9 * * *",
        fireAt: new Date().toISOString(),
        message: "both",
      }),
    });
    assert.equal(r2.status, 400);

    // No message or script
    const r3 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "val-test-3", cron: "0 9 * * *" }),
    });
    assert.equal(r3.status, 400);

    // Invalid cron
    const r4 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "val-test-4", cron: "not-a-cron", message: "bad cron" }),
    });
    assert.equal(r4.status, 400);

    // Invalid fireAt
    const r5 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "val-test-5", fireAt: "not-a-date", message: "bad date" }),
    });
    assert.equal(r5.status, 400);

    // Duplicate id
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 9 * * *", message: "first", id: "dup-test" }),
    });
    const r6 = await daemonRequest(`/api/minds/${TEST_MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 10 * * *", message: "second", id: "dup-test" }),
    });
    assert.equal(r6.status, 409);

    // Clean up
    await daemonRequest(`/api/minds/${TEST_MIND}/schedules/dup-test`, { method: "DELETE" });
  });

  it("delete nonexistent schedule returns 404", async () => {
    await ensureTestMind();
    const res = await daemonRequest(`/api/minds/${TEST_MIND}/schedules/nonexistent`, {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
  });

  it("clock status for nonexistent mind returns 404", async () => {
    const res = await daemonRequest("/api/minds/nonexistent-mind-xyz/clock/status");
    assert.equal(res.status, 404);
  });

  it("sleep state: GET returns not-sleeping for stopped mind", async () => {
    await ensureTestMind();
    const res = await daemonRequest(`/api/minds/${TEST_MIND}/sleep`);
    assert.equal(res.status, 200, `Sleep state: ${await res.clone().text()}`);
    const body = (await res.json()) as { sleeping: boolean };
    assert.equal(body.sleeping, false);
  });

  // ── End Clock & Schedule Tests ──

  it("cross-session history: returns null context when no history", async () => {
    await ensureTestMind();
    const res = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/cross-session?session=test-session`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { context: string | null };
    assert.equal(body.context, null, "Should return null context when no cross-session activity");
  });

  it("cross-session history: returns activity from other sessions", async () => {
    await ensureTestMind();

    // Insert some summary rows directly into mind_history via the history endpoint
    const { getDb } = await import("../src/lib/db.js");
    const { mindHistory } = await import("../src/lib/schema.js");
    const db = await getDb();

    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);

    // Insert summaries for different sessions
    await db.insert(mindHistory).values([
      {
        mind: TEST_MIND,
        session: "discord",
        type: "summary",
        content: "Discussed project updates with Alice",
        turn_id: "turn-1",
        created_at: tenMinAgo.toISOString().replace("T", " ").slice(0, 19),
      },
      {
        mind: TEST_MIND,
        session: "slack",
        type: "summary",
        content: "Reviewed code changes for PR #42",
        turn_id: "turn-2",
        created_at: fiveMinAgo.toISOString().replace("T", " ").slice(0, 19),
      },
      {
        mind: TEST_MIND,
        session: "main",
        type: "summary",
        content: "This should be excluded (same session)",
        turn_id: "turn-3",
        created_at: fiveMinAgo.toISOString().replace("T", " ").slice(0, 19),
      },
    ]);

    // Query cross-session for "main" session
    const res = await daemonRequest(`/api/minds/${TEST_MIND}/history/cross-session?session=main`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { context: string | null };
    assert.ok(body.context, "Should return context");
    assert.ok(body.context!.includes("[Session Activity]"), "Should have header");
    assert.ok(body.context!.includes("discord"), "Should include discord session");
    assert.ok(body.context!.includes("slack"), "Should include slack session");
    assert.ok(!body.context!.includes("excluded"), "Should not include same session");
  });

  it("message proxy returns JSON response", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping message test: ANTHROPIC_API_KEY not set");
      return;
    }

    // Start mind
    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    // May already be running from previous test or 409 if so
    const startBody = (await startRes.json()) as { ok?: boolean; port?: number; error?: string };
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status}: ${JSON.stringify(startBody)}`,
    );
    if (startRes.status === 200) {
      assert.equal(typeof startBody.port, "number", "Start response should include port");
    }

    // Wait for health
    const healthDeadline = Date.now() + 30000;
    let mindHealthy = false;
    while (Date.now() < healthDeadline) {
      const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
      const status = (await statusRes.json()) as { status: string };
      if (status.status === "running") {
        mindHealthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(mindHealthy, "Mind should become healthy");

    // Send message
    const msgRes = await daemonRequest(`/api/minds/${TEST_MIND}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "Reply with just the word 'hello'" }],
        channel: "cli",
        sender: "e2e-test",
      }),
    });

    assert.equal(msgRes.status, 200, `Message failed: ${msgRes.status}`);

    const body = (await msgRes.json()) as { ok: boolean };
    assert.equal(body.ok, true, "Response should have ok: true");

    // Check history
    const historyRes = await daemonRequest(`/api/minds/${TEST_MIND}/history`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as Array<Record<string, unknown>>;
    assert.ok(history.length > 0, "History should have messages");

    // Stop mind
    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
  });
});
