import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { agentDir, findAgent, removeAgent } from "../src/lib/registry.js";

const TEST_AGENT = "e2e-test-agent";
const PORT = 14200 + Math.floor(Math.random() * 800);
const TOKEN = "e2e-test-token-" + Date.now();
const BASE_URL = `http://localhost:${PORT}`;

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
      env: { ...process.env, VOLUTE_DAEMON_TOKEN: TOKEN },
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
      if (findAgent(TEST_AGENT)) {
        removeAgent(TEST_AGENT);
      }
      const dir = agentDir(TEST_AGENT);
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
    const res = await fetch(`${BASE_URL}/api/agents`);
    assert.equal(res.status, 401);
  });

  it("GET /api/agents returns empty array initially", async () => {
    const res = await daemonRequest("/api/agents");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("agent lifecycle: create, start, status, stop", async () => {
    // Create agent via CLI
    execFileSync("npx", ["tsx", "src/cli.ts", "create", TEST_AGENT], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 30000,
    });

    // Install agent dependencies
    const dir = agentDir(TEST_AGENT);
    assert.ok(existsSync(dir), "Agent directory should exist after create");
    execFileSync("npm", ["install"], {
      cwd: dir,
      stdio: "pipe",
      timeout: 60000,
    });

    // Verify agent appears in listing
    const listRes = await daemonRequest("/api/agents");
    assert.equal(listRes.status, 200);
    const agents = (await listRes.json()) as Array<{ name: string; status: string }>;
    const testEntry = agents.find((a) => a.name === TEST_AGENT);
    assert.ok(testEntry, "Test agent should appear in agent list");
    assert.equal(testEntry.status, "stopped");

    // Start agent
    const startRes = await daemonRequest(`/api/agents/${TEST_AGENT}/start`, { method: "POST" });
    assert.equal(startRes.status, 200, `Start failed: ${await startRes.text()}`);

    // Status should show running
    const statusRes = await daemonRequest(`/api/agents/${TEST_AGENT}`);
    assert.equal(statusRes.status, 200);
    const agentStatus = (await statusRes.json()) as { name: string; status: string };
    assert.equal(agentStatus.name, TEST_AGENT);
    assert.ok(
      agentStatus.status === "running" || agentStatus.status === "starting",
      `Expected running or starting, got ${agentStatus.status}`,
    );

    // Stop agent
    const stopRes = await daemonRequest(`/api/agents/${TEST_AGENT}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);

    // Status should show stopped
    const stoppedRes = await daemonRequest(`/api/agents/${TEST_AGENT}`);
    assert.equal(stoppedRes.status, 200);
    const stoppedStatus = (await stoppedRes.json()) as { status: string };
    assert.equal(stoppedStatus.status, "stopped");
  });

  it("message proxy streams ndjson response", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping message test: ANTHROPIC_API_KEY not set");
      return;
    }

    // Start agent
    const startRes = await daemonRequest(`/api/agents/${TEST_AGENT}/start`, { method: "POST" });
    // May already be running from previous test or 409 if so
    assert.ok(
      startRes.status === 200 || startRes.status === 409,
      `Start: expected 200 or 409, got ${startRes.status}`,
    );

    // Wait for health
    const healthDeadline = Date.now() + 30000;
    let agentHealthy = false;
    while (Date.now() < healthDeadline) {
      const statusRes = await daemonRequest(`/api/agents/${TEST_AGENT}`);
      const status = (await statusRes.json()) as { status: string };
      if (status.status === "running") {
        agentHealthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(agentHealthy, "Agent should become healthy");

    // Send message
    const msgRes = await daemonRequest(`/api/agents/${TEST_AGENT}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "Reply with just the word 'hello'" }],
        channel: "cli",
        sender: "e2e-test",
      }),
    });

    assert.equal(msgRes.status, 200, `Message failed: ${msgRes.status}`);
    assert.ok(msgRes.body, "Response should have a body");

    // Read NDJSON stream
    const reader = msgRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    const readDeadline = Date.now() + 60000;
    let done = false;
    while (!done && Date.now() < readDeadline) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.type === "done") done = true;
        } catch {}
      }
    }
    reader.releaseLock();

    assert.ok(events.length > 0, "Should receive at least one event");
    assert.ok(
      events.some((e) => e.type === "done"),
      "Should receive a done event",
    );

    // Check history
    const historyRes = await daemonRequest(`/api/agents/${TEST_AGENT}/history`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as Array<{ role: string }>;
    assert.ok(history.length > 0, "History should have messages");

    // Stop agent
    await daemonRequest(`/api/agents/${TEST_AGENT}/stop`, { method: "POST" });
  });
});
