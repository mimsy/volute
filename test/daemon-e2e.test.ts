import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { findMind, mindDir, removeMind } from "../src/lib/registry.js";

// Strip GIT_* env vars that hook runners (e.g. pre-push) inject, so that
// spawned processes (like `volute create` which runs `git init`) don't
// accidentally operate on the parent repo.
const AGENT_BASE_PORT = 15100 + Math.floor(Math.random() * 800);
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("GIT_") && v !== undefined) cleanEnv[k] = v;
}
cleanEnv.VOLUTE_BASE_PORT = String(AGENT_BASE_PORT);

const TEST_AGENT = "e2e-test-agent";
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
    // Clean up any leftover test agent
    cleanupAgent();

    // Start daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(AGENT_BASE_PORT) },
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
    // Clean up test agent
    cleanupAgent();

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

  function cleanupAgent() {
    try {
      if (findMind(TEST_AGENT)) {
        const entry = findMind(TEST_AGENT);
        if (entry) {
          // Kill any orphan process on the agent's port from a previous crashed run
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
        }
        removeMind(TEST_AGENT);
      }
      const dir = mindDir(TEST_AGENT);
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

  it("agent lifecycle: create, start, status, stop", async () => {
    // Create agent via CLI
    execFileSync("npx", ["tsx", "src/cli.ts", "mind", "create", TEST_AGENT], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 30000,
      env: cleanEnv,
    });

    // Install agent dependencies
    const dir = mindDir(TEST_AGENT);
    assert.ok(existsSync(dir), "Agent directory should exist after create");
    execFileSync("npm", ["install"], {
      cwd: dir,
      stdio: "pipe",
      timeout: 60000,
      env: cleanEnv,
    });

    // Re-establish connection after long sync block (keep-alive connections
    // may have been closed by the server while the event loop was blocked)
    await waitForHealth();

    // Verify agent appears in listing
    const listRes = await daemonRequest("/api/minds");
    assert.equal(listRes.status, 200);
    const agents = (await listRes.json()) as Array<{ name: string; status: string }>;
    const testEntry = agents.find((a) => a.name === TEST_AGENT);
    assert.ok(testEntry, "Test agent should appear in agent list");
    assert.equal(testEntry.status, "stopped");

    // Start agent
    const startRes = await daemonRequest(`/api/minds/${TEST_AGENT}/start`, { method: "POST" });
    assert.equal(startRes.status, 200, `Start failed: ${await startRes.text()}`);

    // Status should show running
    const statusRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
    assert.equal(statusRes.status, 200);
    const agentStatus = (await statusRes.json()) as { name: string; status: string };
    assert.equal(agentStatus.name, TEST_AGENT);
    assert.ok(
      agentStatus.status === "running" || agentStatus.status === "starting",
      `Expected running or starting, got ${agentStatus.status}`,
    );

    // Stop agent
    const stopRes = await daemonRequest(`/api/minds/${TEST_AGENT}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);

    // Status should show stopped
    const stoppedRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
    assert.equal(stoppedRes.status, 200);
    const stoppedStatus = (await stoppedRes.json()) as { status: string };
    assert.equal(stoppedStatus.status, "stopped");
  });

  it("agents persist running state across daemon restart", async () => {
    // Start agent
    const startRes = await daemonRequest(`/api/minds/${TEST_AGENT}/start`, { method: "POST" });
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status}`,
    );

    // Verify running
    const statusRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
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
    const entry = findMind(TEST_AGENT);
    assert.ok(entry, "Agent should still be in registry");
    assert.equal(entry.running, true, "Agent should still be marked as running in registry");

    // Start a new daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(AGENT_BASE_PORT) },
    });
    daemon.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[daemon] ${data}`);
    });

    await waitForHealth();

    // Agent should be auto-restored by the new daemon
    const deadline = Date.now() + 30000;
    let restored = false;
    while (Date.now() < deadline) {
      const res = await daemonRequest(`/api/minds/${TEST_AGENT}`);
      const s = (await res.json()) as { status: string };
      if (s.status === "running") {
        restored = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(restored, "Agent should be auto-restored after daemon restart");

    // Stop agent for subsequent tests
    await daemonRequest(`/api/minds/${TEST_AGENT}/stop`, { method: "POST" });
  });

  it("stopped agents stay stopped across daemon restart", async () => {
    // Agent should be stopped from the previous test — verify
    const statusRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
    const status = (await statusRes.json()) as { status: string };
    assert.equal(status.status, "stopped", "Agent should be stopped before this test");

    // Verify registry shows running: false
    const entryBefore = findMind(TEST_AGENT);
    assert.ok(entryBefore, "Agent should be in registry");
    assert.equal(entryBefore.running, false, "Agent should be marked as not running in registry");

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
    const entryAfter = findMind(TEST_AGENT);
    assert.ok(entryAfter, "Agent should still be in registry");
    assert.equal(entryAfter.running, false, "Stopped agent should remain not running in registry");

    // Start a new daemon
    daemon = spawn("npx", ["tsx", "src/daemon.ts", "--port", String(PORT), "--foreground"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv, VOLUTE_DAEMON_TOKEN: TOKEN, VOLUTE_BASE_PORT: String(AGENT_BASE_PORT) },
    });
    daemon.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[daemon] ${data}`);
    });

    await waitForHealth();

    // Agent should still be stopped — not auto-started
    const restoredRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
    const restoredStatus = (await restoredRes.json()) as { status: string };
    assert.equal(
      restoredStatus.status,
      "stopped",
      "Stopped agent should not be auto-started after daemon restart",
    );
  });

  it("message proxy returns JSON response", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping message test: ANTHROPIC_API_KEY not set");
      return;
    }

    // Start agent
    const startRes = await daemonRequest(`/api/minds/${TEST_AGENT}/start`, { method: "POST" });
    // May already be running from previous test or 409 if so
    const startBody = await startRes.text();
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status}: ${startBody}`,
    );

    // Wait for health
    const healthDeadline = Date.now() + 30000;
    let agentHealthy = false;
    while (Date.now() < healthDeadline) {
      const statusRes = await daemonRequest(`/api/minds/${TEST_AGENT}`);
      const status = (await statusRes.json()) as { status: string };
      if (status.status === "running") {
        agentHealthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(agentHealthy, "Agent should become healthy");

    // Send message
    const msgRes = await daemonRequest(`/api/minds/${TEST_AGENT}/message`, {
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
    const historyRes = await daemonRequest(`/api/minds/${TEST_AGENT}/history`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as Array<Record<string, unknown>>;
    assert.ok(history.length > 0, "History should have messages");

    // Stop agent
    await daemonRequest(`/api/minds/${TEST_AGENT}/stop`, { method: "POST" });
  });
});
