import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { approveUser, createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { loadAllExtensions } from "../src/lib/extensions.js";
import { addMind, removeMind, voluteSystemDir } from "../src/lib/registry.js";
import { users } from "../src/lib/schema.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../src/lib/systems-config.js";
import { authMiddleware, createSession } from "../src/web/middleware/auth.js";

function configPath() {
  return resolve(voluteSystemDir(), "systems.json");
}

// ---------------------------------------------------------------------------
// systems-config unit tests
// ---------------------------------------------------------------------------

describe("systems-config", () => {
  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
  });

  it("readSystemsConfig returns null when no config exists", () => {
    assert.equal(readSystemsConfig(), null);
  });

  it("writeSystemsConfig + readSystemsConfig roundtrips", () => {
    writeSystemsConfig({
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://volute.systems",
    });
    const config = readSystemsConfig();
    assert.deepEqual(config, {
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://volute.systems",
    });
  });

  it("writeSystemsConfig sets file permissions to 0600", () => {
    writeSystemsConfig({
      apiKey: "vp_secret",
      system: "test",
      apiUrl: "https://volute.systems",
    });
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("readSystemsConfig returns null for invalid JSON", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), "not json");
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if apiKey is missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ system: "test" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if system is missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig defaults apiUrl when missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key", system: "test" }));
    const config = readSystemsConfig();
    assert.equal(config?.apiUrl, "https://volute.systems");
  });

  it("readSystemsConfig preserves custom apiUrl", () => {
    writeSystemsConfig({
      apiKey: "vp_key",
      system: "test",
      apiUrl: "http://localhost:9999",
    });
    const config = readSystemsConfig();
    assert.equal(config?.apiUrl, "http://localhost:9999");
  });

  it("deleteSystemsConfig removes the file", () => {
    writeSystemsConfig({
      apiKey: "vp_key",
      system: "test",
      apiUrl: "https://volute.systems",
    });
    assert.ok(existsSync(configPath()));
    const result = deleteSystemsConfig();
    assert.equal(result, true);
    assert.ok(!existsSync(configPath()));
  });

  it("deleteSystemsConfig returns false when no file exists", () => {
    assert.equal(deleteSystemsConfig(), false);
  });
});

// ---------------------------------------------------------------------------
// Daemon API tests for systems management
// ---------------------------------------------------------------------------

/** Collect body from an IncomingMessage */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

/** Helper to build request headers that pass auth + CSRF */
function adminHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

describe("system API routes", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let sessionId: string;
  const MIND_NAME = "pages-test-mind";
  const originalSystemsUrl = process.env.VOLUTE_SYSTEMS_URL;

  async function cleanupAuth() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "pages-admin"));
  }

  async function setupAuth(): Promise<string> {
    const user = await createUser("pages-admin", "pass");
    await approveUser(user.id);
    sessionId = await createSession(user.id);
    return sessionId;
  }

  before(async () => {
    // Start mock HTTP server to act as volute.systems
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.VOLUTE_SYSTEMS_URL = baseUrl;

    addMind(MIND_NAME, 14900);

    // Load extensions into the app so /api/ext/pages/* routes are available
    const { default: app } = await import("../src/web/app.js");
    await loadAllExtensions(app, authMiddleware);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSystemsUrl === undefined) delete process.env.VOLUTE_SYSTEMS_URL;
    else process.env.VOLUTE_SYSTEMS_URL = originalSystemsUrl;
    removeMind(MIND_NAME);
  });

  afterEach(async () => {
    try {
      unlinkSync(configPath());
    } catch {}
    handler = (_req, res) => {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    };
    await cleanupAuth();
  });

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------
  describe("register", () => {
    it("POST /api/system/register registers and saves config", async () => {
      handler = async (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/api/register");
        const body = JSON.parse(await readBody(req));
        assert.equal(body.name, "my-system");
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ apiKey: "vp_newkey", system: "my-system" }));
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("http://localhost/api/system/register", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ name: "my-system" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string };
      assert.equal(data.system, "my-system");

      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_newkey");
      assert.equal(config?.system, "my-system");
    });

    it("POST /api/system/register returns 400 if already registered", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("http://localhost/api/system/register", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ name: "new-name" }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------
  describe("login", () => {
    it("POST /api/system/login validates key and saves config", async () => {
      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, "/api/whoami");
        assert.equal(req.headers.authorization, "Bearer vp_mykey");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ system: "test-system" }));
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("http://localhost/api/system/login", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ key: "vp_mykey" }),
      });

      assert.equal(res.status, 200);
      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_mykey");
      assert.equal(config?.system, "test-system");
    });

    it("POST /api/system/login returns 400 if already logged in", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("http://localhost/api/system/login", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ key: "vp_newkey" }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // logout
  // -----------------------------------------------------------------------
  describe("logout", () => {
    it("POST /api/system/logout removes credentials", async () => {
      writeSystemsConfig({ apiKey: "vp_key", system: "test", apiUrl: baseUrl });
      assert.ok(existsSync(configPath()));

      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("http://localhost/api/system/logout", {
        method: "POST",
        headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
      });

      assert.equal(res.status, 200);
      assert.ok(!existsSync(configPath()));
    });
  });

  // -----------------------------------------------------------------------
  // info
  // -----------------------------------------------------------------------
  describe("info", () => {
    it("GET /api/system/info returns system name when configured", async () => {
      writeSystemsConfig({ apiKey: "vp_key", system: "my-system", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("/api/system/info", {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string | null };
      assert.equal(data.system, "my-system");
    });

    it("GET /api/system/info returns null when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("/api/system/info", {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string | null };
      assert.equal(data.system, null);
    });
  });

  // -----------------------------------------------------------------------
  // pages publish via extension
  // -----------------------------------------------------------------------
  describe("pages publish", () => {
    it("PUT /api/ext/pages/publish proxies to volute.systems", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      let receivedAuth: string | undefined;
      handler = async (req, res) => {
        assert.equal(req.method, "PUT");
        assert.equal(req.url, `/api/pages/publish/${MIND_NAME}`);
        receivedAuth = req.headers.authorization;
        const body = JSON.parse(await readBody(req));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ url: "https://example.com", fileCount: Object.keys(body.files).length }),
        );
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request(`http://localhost/api/ext/pages/publish/${MIND_NAME}`, {
        method: "PUT",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ files: { "index.html": "PGgxPkhlbGxvPC9oMT4=" } }),
      });

      assert.equal(res.status, 200);
      assert.equal(receivedAuth, "Bearer vp_pub");
      const data = (await res.json()) as { url: string; fileCount: number };
      assert.equal(data.fileCount, 1);
    });

    it("PUT /api/ext/pages/publish returns 400 when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request(`http://localhost/api/ext/pages/publish/${MIND_NAME}`, {
        method: "PUT",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ files: {} }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // pages status via extension
  // -----------------------------------------------------------------------
  describe("pages status", () => {
    it("GET /api/ext/pages/status proxies to volute.systems", async () => {
      writeSystemsConfig({ apiKey: "vp_stat", system: "my-system", apiUrl: baseUrl });

      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, `/api/pages/status/${MIND_NAME}`);
        assert.equal(req.headers.authorization, "Bearer vp_stat");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: "https://example.com",
            fileCount: 5,
            deployedAt: "2026-01-15T12:00:00Z",
          }),
        );
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request(`/api/ext/pages/status/${MIND_NAME}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { url: string; fileCount: number; deployedAt: string };
      assert.equal(data.fileCount, 5);
    });

    it("GET /api/ext/pages/status returns 400 when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request(`/api/ext/pages/status/${MIND_NAME}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 400);
    });
  });
});
