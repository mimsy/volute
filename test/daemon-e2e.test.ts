import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  findMind,
  mindDir,
  removeMind,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  activity,
  deliveryQueue,
  mindHistory,
  mindNotices,
  summaries,
  turns,
} from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

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

describe("daemon e2e", { timeout: 420000 }, () => {
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
    daemon = spawn(
      "npx",
      ["tsx", "packages/daemon/src/daemon.ts", "--port", String(PORT), "--foreground"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
      },
    );

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

  /** Poll `lsof` until a process (optionally different from `notPid`) listens on `port`. */
  async function waitForListeningPid(
    port: number,
    timeoutMs: number,
    notPid?: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
          encoding: "utf-8",
        }).trim();
        const pid = out
          .split("\n")
          .filter(Boolean)
          .map((p) => parseInt(p, 10))
          .find((p) => p !== notPid);
        if (pid) return pid;
      } catch {
        // lsof exits non-zero when nothing is listening — keep polling
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `No${notPid ? " new" : ""} process listening on :${port} within ${timeoutMs}ms`,
    );
  }

  /** Poll the daemon API until the test mind reports status "running". */
  async function waitForMindRunning(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await daemonRequest(`/api/minds/${TEST_MIND}`);
      const s = (await res.json()) as { status: string };
      if (s.status === "running") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Mind did not reach running within ${timeoutMs}ms`);
  }

  it("health endpoint returns ok", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("daemon.json is operator-readable (0644) and the admin token is owner-only (0600)", () => {
    // daemon.json (port/hostname) must be readable by a non-root operator CLI on a
    // system install; the token lives in a separate 0600 file.
    const daemonJson = resolve(voluteSystemDir(), "daemon.json");
    assert.ok(existsSync(daemonJson), "daemon.json should exist");
    assert.equal(statSync(daemonJson).mode & 0o777, 0o644, "daemon.json should be 0644");
    assert.ok(
      !readFileSync(daemonJson, "utf-8").includes("token"),
      "daemon.json must not hold the token",
    );

    const tokenFile = resolve(voluteSystemDir(), "daemon-token");
    assert.ok(existsSync(tokenFile), "daemon-token should exist");
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, "daemon-token should be 0600");
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

  it("GET /api/extensions/mind-docs lists notes with a mindDoc and commands", async () => {
    const res = await daemonRequest("/api/extensions/mind-docs");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      mindDoc: string;
      commands: string[];
    }[];
    assert.ok(Array.isArray(body));
    const notes = body.find((e) => e.id === "notes");
    assert.ok(notes, "notes extension should be present in mind-docs");
    assert.ok(notes.mindDoc.length > 0, "notes should expose a mindDoc");
    assert.ok(notes.commands.includes("write"), "notes commands should include write");
  });

  it("unauthenticated mind-docs request returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/extensions/mind-docs`);
    assert.equal(res.status, 401);
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

  it("avatar upload: resized to webp, served with ETag, revalidates with 304", async () => {
    const sharp = (await import("sharp")).default;
    const bigPng = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 40, g: 40, b: 200 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append("file", new File([new Uint8Array(bigPng)], "big.png", { type: "image/png" }));
    const uploadRes = await daemonRequest(`/api/minds/${TEST_MIND}/avatar`, {
      method: "POST",
      body: form,
    });
    const uploadText = await uploadRes.text();
    assert.equal(uploadRes.status, 200, `Upload failed: ${uploadText}`);
    const uploaded = JSON.parse(uploadText) as { avatar: string };
    assert.equal(uploaded.avatar, "avatar.webp");

    const getRes = await daemonRequest(`/api/minds/${TEST_MIND}/avatar`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("content-type"), "image/webp");
    const etag = getRes.headers.get("etag");
    assert.ok(etag, "avatar response should carry an ETag");
    const body = new Uint8Array(await getRes.arrayBuffer());
    const meta = await sharp(Buffer.from(body)).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);

    const revalidateRes = await daemonRequest(`/api/minds/${TEST_MIND}/avatar`, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(revalidateRes.status, 304);
  });

  it("GET /:name/delivery/pending previews gated messages and clears once released", async () => {
    const db = await getDb();
    // The daemon and this test share volute.db, so directly seeding gated rows is a
    // deterministic way to exercise the pending-preview API without a real gating race.
    await db.insert(deliveryQueue).values([
      {
        mind: TEST_MIND,
        session: "main",
        channel: "slack:random",
        sender: "zoe",
        status: "gated",
        payload: JSON.stringify({
          channel: "slack:random",
          sender: "zoe",
          content: "first held message",
        }),
      },
      {
        mind: TEST_MIND,
        session: "main",
        channel: "slack:random",
        sender: "amp",
        status: "gated",
        payload: JSON.stringify({
          channel: "slack:random",
          sender: "amp",
          content: "second held message",
        }),
      },
    ]);

    const res = await daemonRequest(`/api/minds/${TEST_MIND}/delivery/pending`);
    assert.equal(res.status, 200);
    const pending = (await res.json()) as Array<{
      channel: string;
      count: number;
      preview: string;
    }>;
    const entry = pending.find((p) => p.channel === "slack:random");
    assert.ok(entry, "gated channel should appear in pending preview");
    assert.equal(entry.count, 2);
    assert.match(entry.preview, /held message/);

    // Releasing (delivering) the gated rows clears them from the preview.
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, TEST_MIND));
    const res2 = await daemonRequest(`/api/minds/${TEST_MIND}/delivery/pending`);
    const pending2 = (await res2.json()) as Array<{ channel: string }>;
    assert.ok(
      !pending2.find((p) => p.channel === "slack:random"),
      "released messages should no longer be pending",
    );
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
    daemon = spawn(
      "npx",
      ["tsx", "packages/daemon/src/daemon.ts", "--port", String(PORT), "--foreground"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
      },
    );
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
    daemon = spawn(
      "npx",
      ["tsx", "packages/daemon/src/daemon.ts", "--port", String(PORT), "--foreground"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(MIND_BASE_PORT) },
      },
    );
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

  it("crash recovery: daemon restarts a mind whose process dies", { timeout: 60000 }, async () => {
    const entry = await findMind(TEST_MIND);
    assert.ok(entry, "test mind should be registered");

    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status} ${await startRes.clone().text()}`,
    );
    await waitForMindRunning();

    // Kill the mind's server process out from under the daemon.
    const oldPid = await waitForListeningPid(entry.port, 15000);
    process.kill(oldPid, "SIGKILL");

    // Crash recovery has a 3s first-attempt backoff, then respawns via tsx.
    const newPid = await waitForListeningPid(entry.port, 30000, oldPid);
    assert.notEqual(newPid, oldPid, "a new process should be listening after crash recovery");

    await waitForMindRunning();

    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
  });

  it("variants: split creates a worktree variant, merge folds it back into the parent", {
    timeout: 300000,
  }, async () => {
    await ensureTestMind();
    const parentDir = mindDir(TEST_MIND);

    // Split: create the variant without starting its server.
    const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-var", noStart: true }),
    });
    assert.equal(createRes.status, 200, `Split: ${await createRes.clone().text()}`);
    const created = (await createRes.json()) as {
      ok: boolean;
      variant: { name: string; branch: string; path: string; port: number };
    };
    assert.equal(created.ok, true);
    assert.ok(existsSync(created.variant.path), "variant worktree should exist");

    // Variant is registered with the parent.
    const listRes = await daemonRequest(`/api/minds/${TEST_MIND}/variants`);
    assert.equal(listRes.status, 200);
    const variants = (await listRes.json()) as { name: string }[];
    assert.ok(
      variants.some((v) => v.name === "e2e-var"),
      `expected e2e-var in ${JSON.stringify(variants)}`,
    );

    // The variant does some work: a new tracked file in src/.
    // (Merge auto-commits uncommitted worktree changes; src/ is always tracked.)
    writeFileSync(
      resolve(created.variant.path, "src", "e2e-merge-marker.ts"),
      'export const marker = "e2e";\n',
    );

    // Join: merge the variant back. skipVerify avoids booting a verification server.
    const mergeRes = await daemonRequest(`/api/minds/${TEST_MIND}/variants/e2e-var/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipVerify: true, summary: "e2e merge test" }),
    });
    assert.equal(mergeRes.status, 200, `Merge: ${await mergeRes.clone().text()}`);
    const mergeBody = (await mergeRes.json()) as { ok: boolean; warning?: string };
    assert.equal(mergeBody.ok, true);
    assert.equal(mergeBody.warning, undefined, `merge reported a warning: ${mergeBody.warning}`);

    // The variant's change landed in the parent working tree.
    assert.ok(
      existsSync(resolve(parentDir, "src", "e2e-merge-marker.ts")),
      "merged file should exist in the parent src/",
    );

    // The variant is cleaned up: gone from registry and disk.
    assert.ok(!(await findMind("e2e-var")), "variant should be removed from the registry");
    assert.ok(!existsSync(created.variant.path), "variant worktree should be removed");

    // Merge restarts the parent — wait for it, then stop it for subsequent tests.
    await waitForMindRunning(60000);
    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
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
    const createRes = await daemonRequest("/api/v1/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-bridge-channel" }),
    });
    assert.equal(createRes.status, 201, `Create: ${await createRes.clone().text()}`);
    const created = (await createRes.json()) as { id: string; name: string };
    assert.ok(created.id);

    // List channels — should include the new one
    const listRes = await daemonRequest("/api/v1/channels");
    assert.equal(listRes.status, 200);
    const channels = (await listRes.json()) as { channel_name: string; id: string }[];
    assert.ok(channels.some((ch) => ch.channel_name === "test-bridge-channel"));

    // Invite the test mind to the channel
    const inviteRes = await daemonRequest("/api/v1/channels/test-bridge-channel/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: TEST_MIND }),
    });
    assert.equal(inviteRes.status, 200, `Invite: ${await inviteRes.clone().text()}`);

    // List members — should include the mind
    const membersRes = await daemonRequest("/api/v1/channels/test-bridge-channel/members");
    assert.equal(membersRes.status, 200);
    const members = (await membersRes.json()) as { username: string }[];
    assert.ok(
      members.some((m) => m.username === TEST_MIND),
      `Expected ${TEST_MIND} in members: ${JSON.stringify(members)}`,
    );
  });

  it("channel writes (PATCH settings, invite) require membership for non-admin callers", async () => {
    // Admin creates a channel.
    const createRes = await daemonRequest("/api/v1/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-authz-channel" }),
    });
    assert.equal(createRes.status, 201, `create: ${await createRes.clone().text()}`);

    // A mind principal that is NOT a member of the channel.
    const outsider = await getOrCreateMindUser("e2e-channel-outsider");
    const outsiderSession = await createSession(outsider.id);
    const asOutsider = (path: string, options?: RequestInit): Promise<Response> => {
      const headers = new Headers(options?.headers);
      headers.set("Authorization", `Bearer ${outsiderSession}`);
      headers.set("Origin", BASE_URL);
      return fetch(`${BASE_URL}${path}`, { ...options, headers });
    };

    // Non-member cannot change settings...
    const patchDenied = await asOutsider("/api/v1/channels/e2e-authz-channel", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(patchDenied.status, 403, "non-member PATCH must be forbidden");

    // ...nor invite others.
    const inviteDenied = await asOutsider("/api/v1/channels/e2e-authz-channel/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "e2e-channel-victim" }),
    });
    assert.equal(inviteDenied.status, 403, "non-member invite must be forbidden");

    // Once the mind joins, it becomes a member and may change settings.
    const joinRes = await asOutsider("/api/v1/channels/e2e-authz-channel/join", { method: "POST" });
    assert.equal(joinRes.status, 200, `join: ${await joinRes.clone().text()}`);

    const patchOk = await asOutsider("/api/v1/channels/e2e-authz-channel", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "set by member" }),
    });
    assert.equal(patchOk.status, 200, `member PATCH: ${await patchOk.clone().text()}`);
    const patched = (await patchOk.json()) as { settings?: { description?: string } };
    assert.equal(patched.settings?.description, "set by member");
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

    // Send a message via the unified chat endpoint
    const chatRes = await daemonRequest("/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conv.id,
        message: "hello from integration test",
        targetMind: TEST_MIND,
      }),
    });
    assert.equal(chatRes.status, 200, `Chat: ${await chatRes.clone().text()}`);

    // Read messages back
    const msgsRes = await daemonRequest(
      `/api/minds/${TEST_MIND}/conversations/${conv.id}/messages`,
    );
    assert.equal(msgsRes.status, 200);
    const { items: messages } = (await msgsRes.json()) as {
      items: { content: { type: string; text?: string }[]; sender_name: string }[];
    };
    assert.ok(messages.length >= 1);
    const lastMsg = messages[messages.length - 1];
    const text = lastMsg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    assert.ok(text.includes("hello from integration test"), `Message text: ${text}`);
  });

  it("upgrade: rejects an unknown template with 400", async () => {
    await ensureTestMind();

    const res = await daemonRequest(`/api/minds/${TEST_MIND}/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "../../evil" }),
    });
    assert.equal(res.status, 400, `Expected 400, got ${res.status} ${await res.clone().text()}`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /unknown template/i);

    // The bogus value must not have been written to the registry.
    const entry = await findMind(TEST_MIND);
    assert.notEqual(entry?.template, "../../evil");
  });

  it("unified chat: send via /api/v1/chat", async () => {
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
    const chatRes = await daemonRequest("/api/v1/chat", {
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
    const { items: messages } = (await msgsRes.json()) as {
      items: { content: { type: string; text?: string }[] }[];
    };
    assert.ok(messages.length >= 1);
  });

  it("last-known-good: recovers when a self-edit to src/ breaks startup", {
    timeout: 90000,
  }, async () => {
    await ensureTestMind();
    const dir = mindDir(TEST_MIND);

    // Deps are installed by the "mind lifecycle" test; install as a fallback if missing.
    if (!existsSync(resolve(dir, "node_modules"))) {
      execFileSync("npm", ["install"], { cwd: dir, stdio: "pipe", timeout: 60000, env: cleanEnv });
      await waitForHealth();
    }

    // Make sure the mind is running on good code.
    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status} ${await startRes.clone().text()}`,
    );

    const serverPath = resolve(dir, "src", "server.ts");
    const goodSource = readFileSync(serverPath, "utf-8");

    // The mind edits its own server source and breaks it (uncommitted, as a real self-edit
    // would be — the auto-commit hook only tracks home/).
    writeFileSync(serverPath, `${goodSource}\nthis is not valid typescript !!! (((\n`);

    // Restart: the daemon should detect the broken startup, park the change, restore the
    // last known-good src/, and come back up rather than dying.
    const restartRes = await daemonRequest(`/api/minds/${TEST_MIND}/restart`, { method: "POST" });
    assert.equal(
      restartRes.status,
      200,
      `Restart: ${restartRes.status} ${await restartRes.clone().text()}`,
    );
    const body = (await restartRes.json()) as { recovered?: boolean; brokenBranch?: string };
    assert.equal(body.recovered, true, "restart should report last-known-good recovery");
    assert.ok(
      body.brokenBranch?.startsWith("broken/"),
      `expected a broken/* branch, got ${body.brokenBranch}`,
    );

    // The working tree src/ is restored to the previous good code.
    assert.equal(
      readFileSync(serverPath, "utf-8"),
      goodSource,
      "src/server.ts should be restored to the good version",
    );

    // The mind is back up.
    const statusRes = await daemonRequest(`/api/minds/${TEST_MIND}`);
    const status = (await statusRes.json()) as { status: string };
    assert.ok(
      status.status === "running" || status.status === "starting",
      `Expected running/starting after recovery, got ${status.status}`,
    );

    // The broken change is preserved on a broken/* branch.
    const branches = execFileSync("git", ["branch", "--list", "broken/*"], {
      cwd: dir,
      encoding: "utf-8",
      env: cleanEnv,
    });
    assert.ok(branches.includes("broken/"), `expected a broken/* branch, got: ${branches}`);

    // A startup notice was recorded, carrying the failed child's stderr.
    const db = await getDb();
    const rows = await db.select().from(mindNotices).where(eq(mindNotices.mind, TEST_MIND));
    const startupNotice = rows.find((r) => r.kind === "startup");
    assert.ok(startupNotice, "a startup notice should be recorded");
    assert.ok(
      startupNotice.raw != null && startupNotice.raw.length > 0,
      "startup notice should carry the failed process stderr",
    );
    assert.ok(
      startupNotice.detail.includes(body.brokenBranch ?? "broken/"),
      "notice should name the broken branch",
    );

    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
  });

  it("bridge config: set, mappings CRUD, remove", async () => {
    const { setBridgeConfig, removeBridgeConfig } = await import(
      "../packages/daemon/src/lib/bridges/bridges.js"
    );

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
    const { setBridgeConfig, removeBridgeConfig } = await import(
      "../packages/daemon/src/lib/bridges/bridges.js"
    );

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
    const { items: messages } = (await msgsRes.json()) as {
      items: { content: { type: string; text?: string }[]; sender_name: string }[];
    };
    const bridgedMsg = messages.find((m) => m.sender_name === "Alice");
    assert.ok(bridgedMsg, `Expected message from Alice, got: ${JSON.stringify(messages)}`);

    // Clean up
    removeBridgeConfig("test-inbound");
  });

  it("bridge inbound: DM creates conversation with default mind", async () => {
    await ensureTestMind();
    const { setBridgeConfig, removeBridgeConfig } = await import(
      "../packages/daemon/src/lib/bridges/bridges.js"
    );

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
    const { items: messages } = (await msgsRes.json()) as {
      items: { sender_name: string }[];
    };
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
    const { setBridgeConfig, getBridgeConfig } = await import(
      "../packages/daemon/src/lib/bridges/bridges.js"
    );

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
    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { summaries, turns } = await import("../packages/daemon/src/lib/schema.js");
    const db = await getDb();

    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

    // Insert turns and summaries for different sessions
    await db.insert(turns).values([
      { id: "turn-1", mind: TEST_MIND, session: "discord", status: "complete" },
      { id: "turn-2", mind: TEST_MIND, session: "slack", status: "complete" },
      { id: "turn-3", mind: TEST_MIND, session: "main", status: "complete" },
    ]);
    await db.insert(summaries).values([
      {
        mind: TEST_MIND,
        period: "turn",
        period_key: "turn-1",
        content: "Discussed project updates with Alice",
        created_at: fmt(tenMinAgo),
      },
      {
        mind: TEST_MIND,
        period: "turn",
        period_key: "turn-2",
        content: "Reviewed code changes for PR #42",
        created_at: fmt(fiveMinAgo),
      },
      {
        mind: TEST_MIND,
        period: "turn",
        period_key: "turn-3",
        content: "This should be excluded (same session)",
        created_at: fmt(fiveMinAgo),
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

  it("cross-session history: uses turn boundary as since timestamp", async () => {
    await ensureTestMind();

    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { mindHistory, summaries, turns } = await import("../packages/daemon/src/lib/schema.js");
    const db = await getDb();

    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60_000);
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

    // Insert a turn for the requesting session ("web") — this sets the boundary
    await db.insert(mindHistory).values([
      {
        mind: TEST_MIND,
        session: "web",
        type: "inbound",
        content: "hello",
        turn_id: "web-turn-1",
        created_at: fmt(tenMinAgo),
      },
      {
        mind: TEST_MIND,
        session: "web",
        type: "outbound",
        content: "hi there",
        turn_id: "web-turn-1",
        created_at: fmt(fiveMinAgo),
      },
    ]);

    // Insert turns and summaries: one before the turn boundary, one after
    await db.insert(turns).values([
      { id: "old-turn", mind: TEST_MIND, session: "telegram", status: "complete" },
      { id: "new-turn", mind: TEST_MIND, session: "telegram", status: "complete" },
    ]);
    await db.insert(summaries).values([
      {
        mind: TEST_MIND,
        period: "turn",
        period_key: "old-turn",
        content: "Old activity before turn boundary",
        created_at: fmt(thirtyMinAgo),
      },
      {
        mind: TEST_MIND,
        period: "turn",
        period_key: "new-turn",
        content: "New activity after turn boundary",
        created_at: fmt(fiveMinAgo),
      },
    ]);

    // Turn boundary = start of web-turn-1 = tenMinAgo
    const res = await daemonRequest(`/api/minds/${TEST_MIND}/history/cross-session?session=web`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { context: string | null };
    assert.ok(body.context, "Should return context");
    assert.ok(
      !body.context!.includes("Old activity before turn boundary"),
      "Should exclude summaries from before the turn boundary",
    );
    assert.ok(
      body.context!.includes("New activity after turn boundary"),
      "Should include summaries from after the turn boundary",
    );
  });

  const emitEvent = (session: string, body: Record<string, unknown>) =>
    daemonRequest(`/api/minds/${TEST_MIND}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, ...body }),
    });

  it("failure notices: recorded on error, drained, delivered after a clean turn", async () => {
    await ensureTestMind();
    const session = "notices-401";

    // Turn 1 fails with a 401 — the daemon records a notice, not delivered yet.
    await emitEvent(session, { type: "error", content: "API Error: 401 authentication_error" });
    await emitEvent(session, { type: "done" });

    // The mind's next turn drains the notice (does not mark it delivered).
    const drain1 = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/notices?session=${session}`,
    );
    assert.equal(drain1.status, 200);
    const body1 = (await drain1.json()) as { context: string | null; notices: unknown[] };
    assert.ok(body1.context, "should return notice context");
    assert.match(body1.context!, /credential/i);
    assert.equal(body1.notices.length, 1);

    // That turn completes cleanly (no error) → notice is marked delivered.
    await emitEvent(session, { type: "done" });
    const drain2 = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/notices?session=${session}`,
    );
    const body2 = (await drain2.json()) as { context: string | null; notices: unknown[] };
    assert.equal(body2.context, null);
    assert.equal(body2.notices.length, 0);
  });

  it("failure notices: accumulate across an outage to convey full scope", async () => {
    await ensureTestMind();
    const session = "notices-outage";

    // Three turns fail in a row before one succeeds.
    for (let i = 0; i < 3; i++) {
      await emitEvent(session, { type: "error", content: "fetch failed: ECONNRESET" });
      await emitEvent(session, { type: "done" });
    }

    const drain = await daemonRequest(`/api/minds/${TEST_MIND}/history/notices?session=${session}`);
    const body = (await drain.json()) as { context: string; notices: unknown[] };
    assert.equal(body.notices.length, 3, "all three failures retained");
    assert.match(body.context, /3 turns failed/);

    // A clean turn clears them all.
    await emitEvent(session, { type: "done" });
    const after = await daemonRequest(`/api/minds/${TEST_MIND}/history/notices?session=${session}`);
    assert.equal(((await after.json()) as { notices: unknown[] }).notices.length, 0);
  });

  it("failure notices: a drained-then-errored turn does NOT deliver them", async () => {
    await ensureTestMind();
    const session = "notices-errored-after-drain";

    // Turn 1 fails → notice queued.
    await emitEvent(session, { type: "error", content: "API Error: 401 authentication_error" });
    await emitEvent(session, { type: "done" });

    // Turn 2 drains it (the mind reads it)...
    const drained = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/notices?session=${session}`,
    );
    assert.equal(((await drained.json()) as { notices: unknown[] }).notices.length, 1);

    // ...but turn 2 itself ALSO fails before completing.
    await emitEvent(session, { type: "error", content: "fetch failed: ECONNRESET" });
    await emitEvent(session, { type: "done" });

    // The drained notice must survive (the turn that read it failed), plus the new one.
    const stillThere = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/notices?session=${session}`,
    );
    assert.equal(
      ((await stillThere.json()) as { notices: unknown[] }).notices.length,
      2,
      "drained notice not cleared by a failed turn; new failure accumulated",
    );

    // Now a genuinely clean turn clears everything.
    await emitEvent(session, { type: "done" });
    const cleared = await daemonRequest(
      `/api/minds/${TEST_MIND}/history/notices?session=${session}`,
    );
    assert.equal(((await cleared.json()) as { notices: unknown[] }).notices.length, 0);
  });

  it("chat delivery: message reaches a running mind and lands in history", {
    timeout: 60000,
  }, async () => {
    await ensureTestMind();

    const startRes = await daemonRequest(`/api/minds/${TEST_MIND}/start`, { method: "POST" });
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status} ${await startRes.clone().text()}`,
    );
    await waitForMindRunning();

    // Send through the unified chat endpoint (the real CLI/web send path).
    const createRes = await daemonRequest(`/api/minds/${TEST_MIND}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "delivery round-trip", participantNames: [TEST_MIND] }),
    });
    assert.equal(createRes.status, 201, `Create conv: ${await createRes.clone().text()}`);
    const conv = (await createRes.json()) as { id: string };

    const probe = `delivery round-trip probe ${Date.now()}`;
    const chatRes = await daemonRequest("/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conv.id, message: probe, targetMind: TEST_MIND }),
    });
    assert.equal(chatRes.status, 200, `Chat: ${await chatRes.clone().text()}`);

    // Delivery is async (queue → HTTP POST to the mind → recordInbound). Inbound
    // recording happens at delivery time, before the mind's model turn, so this
    // works without ANTHROPIC_API_KEY. Poll history for the probe.
    const deadline = Date.now() + 30000;
    let delivered = false;
    while (Date.now() < deadline && !delivered) {
      const res = await daemonRequest(`/api/minds/${TEST_MIND}/history?full=true&limit=100`);
      assert.equal(res.status, 200);
      const rows = (await res.json()) as { type: string; content: string | null }[];
      delivered = rows.some((r) => r.type === "inbound" && (r.content ?? "").includes(probe));
      if (!delivered) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(delivered, "inbound message should be recorded in mind_history after delivery");

    await daemonRequest(`/api/minds/${TEST_MIND}/stop`, { method: "POST" });
  });

  it("mind defaults: GET returns empty object when not configured", async () => {
    const res = await daemonRequest("/api/v1/system/mind-defaults");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, {});
  });

  it("mind defaults: PUT saves and GET returns saved values", async () => {
    const defaults = {
      cognition: {
        model: "claude-sonnet-4-20250514",
        thinkingLevel: "medium" as const,
        tokenBudget: 50000,
        tokenBudgetPeriodMinutes: 60,
      },
      sleep: {
        enabled: true,
        schedule: { sleep: "0 23 * * *", wake: "0 7 * * *" },
        wakeTriggers: { mentions: true, dms: false },
      },
      schedules: [
        {
          id: "morning",
          cron: "0 9 * * *",
          message: "Good morning",
          enabled: true,
          whileSleeping: "skip" as const,
        },
      ],
    };
    const putRes = await daemonRequest("/api/v1/system/mind-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaults),
    });
    assert.equal(putRes.status, 200);

    const getRes = await daemonRequest("/api/v1/system/mind-defaults");
    assert.equal(getRes.status, 200);
    const saved = await getRes.json();
    assert.equal(saved.cognition.model, "claude-sonnet-4-20250514");
    assert.equal(saved.cognition.thinkingLevel, "medium");
    assert.equal(saved.cognition.tokenBudget, 50000);
    assert.equal(saved.sleep.enabled, true);
    assert.equal(saved.sleep.schedule.sleep, "0 23 * * *");
    assert.equal(saved.sleep.wakeTriggers.mentions, true);
    assert.equal(saved.schedules.length, 1);
    assert.equal(saved.schedules[0].id, "morning");

    // Clean up: reset to empty
    await daemonRequest("/api/v1/system/mind-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  describe("history API cross-tenant authorization", () => {
    const ALICE = "e2e-hist-alice";
    const BOB = "e2e-hist-bob";
    const BOB_SECRET = "BOB-PRIVATE-DM-SECRET";
    const ALICE_SECRET = "ALICE-PRIVATE-DM-SECRET";
    let aliceSession: string;
    let bobSummaryId: number;

    // Request as mind Alice using a DB-backed session (the daemon shares this
    // test's VOLUTE_HOME, so a session created here resolves to Alice's
    // non-admin mind user inside the daemon).
    function aliceRequest(path: string): Promise<Response> {
      return fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${aliceSession}`, Origin: BASE_URL },
      });
    }

    before(async () => {
      const db = await getDb();
      const alice = await getOrCreateMindUser(ALICE);
      await getOrCreateMindUser(BOB);
      aliceSession = await createSession(alice.id);

      // Seed a turn + private DM content + summary + activity for each mind.
      for (const [mind, secret] of [
        [ALICE, ALICE_SECRET],
        [BOB, BOB_SECRET],
      ] as const) {
        const turnId = `${mind}-turn-1`;
        await db.insert(turns).values({ id: turnId, mind, status: "done" });
        await db.insert(mindHistory).values({
          mind,
          channel: "@partner",
          sender: "partner",
          type: "inbound",
          content: secret,
          turn_id: turnId,
        });
        await db
          .insert(summaries)
          .values({ mind, period: "turn", period_key: turnId, content: `${secret} summary` });
        await db.insert(activity).values({ type: "message", mind, summary: `${secret} activity` });
      }

      const bobSummary = await db
        .select({ id: summaries.id })
        .from(summaries)
        .where(eq(summaries.mind, BOB))
        .get();
      bobSummaryId = bobSummary!.id;
    });

    it("/turns ignores ?mind= for a mind principal and never leaks another mind", async () => {
      const res = await aliceRequest(`/api/v1/history/turns?mind=${BOB}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      const text = JSON.stringify(body);
      assert.ok(!text.includes(BOB_SECRET), "Alice must not see Bob's private DM content");
      assert.ok(
        body.every((t) => t.mind === ALICE),
        "Alice's turn query must only return Alice's turns",
      );
      // Alice still sees her own turn (filter forced to self, not denied).
      assert.ok(
        body.some((t) => t.id === `${ALICE}-turn-1`),
        "Alice should see her own turn",
      );
    });

    it("/summaries ignores ?mind= for a mind principal", async () => {
      const res = await aliceRequest(`/api/v1/history/summaries?mind=${BOB}&period=turn`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      assert.ok(
        body.every((s) => s.mind === ALICE),
        "Alice must only receive her own summaries",
      );
      assert.ok(!JSON.stringify(body).includes(BOB_SECRET));
    });

    it("/summaries by ids cannot reach another mind's summary", async () => {
      const res = await aliceRequest(`/api/v1/history/summaries?ids=${bobSummaryId}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      assert.equal(body.length, 0, "Alice must not fetch Bob's summary by id");
    });

    it("/activity ignores ?mind= for a mind principal", async () => {
      const res = await aliceRequest(`/api/v1/history/activity?mind=${BOB}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      assert.ok(
        body.every((a) => a.mind === ALICE),
        "Alice must only receive her own activity",
      );
      assert.ok(!JSON.stringify(body).includes(BOB_SECRET));
    });

    it("admin/daemon token may still query another mind (behavior preserved)", async () => {
      const res = await daemonRequest(`/api/v1/history/turns?mind=${BOB}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      assert.ok(
        body.some((t) => t.mind === BOB),
        "Admin should still be able to read Bob's turns",
      );
    });

    // Open an SSE connection to /api/v1/events, return the first `snapshot`
    // event, then abort. The snapshot's `activity` array is the vector at risk
    // of a cross-tenant leak.
    async function readEventsSnapshot(
      authHeader: string,
    ): Promise<{ activity: Array<{ mind: string }> }> {
      const controller = new AbortController();
      const res = await fetch(`${BASE_URL}/api/v1/events`, {
        headers: { Authorization: authHeader, Origin: BASE_URL },
        signal: controller.signal,
      });
      assert.equal(res.status, 200, "events stream should connect");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const sep = buf.indexOf("\n\n");
            if (sep === -1) break;
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(dataLine.indexOf(":") + 1).trim();
            if (!json) continue;
            const parsed = JSON.parse(json);
            if (parsed.event === "snapshot") return parsed;
          }
        }
      } finally {
        controller.abort();
        try {
          await reader.cancel();
        } catch {}
      }
      throw new Error("no snapshot event received");
    }

    it("/api/v1/events snapshot scopes activity to the caller's own mind", async () => {
      const snap = await readEventsSnapshot(`Bearer ${aliceSession}`);
      assert.ok(
        snap.activity.every((a) => a.mind === ALICE),
        "Alice's snapshot must only contain her own activity",
      );
      assert.ok(
        !JSON.stringify(snap.activity).includes(BOB_SECRET),
        "Alice's snapshot must not leak Bob's activity",
      );
      assert.ok(
        snap.activity.some((a) => a.mind === ALICE),
        "Alice should still see her own activity",
      );
    });

    it("/api/v1/events snapshot keeps the global feed for admin/system", async () => {
      const snap = await readEventsSnapshot(`Bearer ${TOKEN}`);
      assert.ok(
        snap.activity.some((a) => a.mind !== ALICE),
        "Admin snapshot should include activity beyond a single mind (global feed)",
      );
    });
  });

  it("extension command endpoint ignores body.mind for non-admin callers", async () => {
    // Register a seed admin first so subsequent registrations are non-admin.
    // (The first brain user always becomes admin.)
    await daemonRequest("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "e2e-seed-admin", password: "seed-pass-123" }),
    });

    // Register attacker + victim as non-admin (pending) brain users, then approve.
    async function registerAndApprove(username: string): Promise<void> {
      const regRes = await daemonRequest("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "attack-pass-123" }),
      });
      const regBody = (await regRes.json()) as { id: number; role: string };
      assert.equal(regRes.status, 200, `register ${username}: ${JSON.stringify(regBody)}`);
      assert.notEqual(regBody.role, "admin", `${username} must not be the first (admin) user`);
      // Approve via daemon token (admin).
      const apRes = await daemonRequest(`/api/auth/users/${regBody.id}/approve`, {
        method: "POST",
      });
      assert.equal(apRes.status, 200, `approve ${username}: ${apRes.status}`);
    }
    await registerAndApprove("e2e-notes-attacker");
    await registerAndApprove("e2e-notes-victim");

    // Log in as attacker to obtain a non-admin session token.
    const loginRes = await daemonRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "e2e-notes-attacker", password: "attack-pass-123" }),
    });
    const loginBody = (await loginRes.json()) as { sessionId: string };
    assert.equal(loginRes.status, 200, `login: ${JSON.stringify(loginBody)}`);
    const { sessionId } = loginBody;
    assert.ok(sessionId, "login should return a session token");

    // Attacker attempts to publish a note authored as the victim via body.mind.
    const attackRes = await fetch(`${BASE_URL}/api/ext/notes/commands/write`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionId}`,
        Origin: BASE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mind: "e2e-notes-victim", args: ["Impersonation Attempt", "body"] }),
    });
    assert.equal(attackRes.status, 200, `write: ${await attackRes.clone().text()}`);
    const attackBody = (await attackRes.json()) as { output?: string; error?: string };
    assert.ok(attackBody.output, `expected output, got ${JSON.stringify(attackBody)}`);
    // body.mind must be ignored: the note is authored by the caller, not the victim.
    assert.match(attackBody.output, /Published: e2e-notes-attacker\//);
    assert.doesNotMatch(attackBody.output, /Published: e2e-notes-victim\//);

    // An admin (daemon token) can still target a specific mind via body.mind.
    const adminRes = await daemonRequest("/api/ext/notes/commands/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mind: "e2e-notes-victim", args: ["Admin Targeted", "body"] }),
    });
    assert.equal(adminRes.status, 200, `admin write: ${await adminRes.clone().text()}`);
    const adminBody = (await adminRes.json()) as { output?: string; error?: string };
    assert.ok(adminBody.output, `expected output, got ${JSON.stringify(adminBody)}`);
    assert.match(adminBody.output, /Published: e2e-notes-victim\//);
  });
});
