import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { addMind, mindDir, removeMind, voluteHome } from "@volute/shared/registry";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "@volute/shared/systems-config";
import { collectFiles } from "../src/commands/pages/publish.js";

function configPath() {
  return resolve(voluteHome(), "systems.json");
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
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), "not json");
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if apiKey is missing", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ system: "test" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if system is missing", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig defaults apiUrl when missing", () => {
    mkdirSync(voluteHome(), { recursive: true });
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
// collectFiles unit tests
// ---------------------------------------------------------------------------

describe("collectFiles", () => {
  it("collects files recursively with base64 encoding", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-test-"));
    writeFileSync(resolve(tmp, "index.html"), "<h1>Hello</h1>");
    mkdirSync(resolve(tmp, "css"));
    writeFileSync(resolve(tmp, "css", "style.css"), "body { color: red; }");

    const files = collectFiles(tmp);
    assert.equal(Object.keys(files).length, 2);
    assert.ok("index.html" in files);
    assert.ok("css/style.css" in files);
    assert.equal(Buffer.from(files["index.html"], "base64").toString(), "<h1>Hello</h1>");
    assert.equal(Buffer.from(files["css/style.css"], "base64").toString(), "body { color: red; }");
  });

  it("returns empty object for empty directory", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-empty-"));
    const files = collectFiles(tmp);
    assert.deepEqual(files, {});
  });

  it("handles deeply nested directories", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-deep-"));
    mkdirSync(resolve(tmp, "a", "b", "c"), { recursive: true });
    writeFileSync(resolve(tmp, "a", "b", "c", "deep.txt"), "deep content");

    const files = collectFiles(tmp);
    assert.equal(Object.keys(files).length, 1);
    assert.ok("a/b/c/deep.txt" in files);
  });

  it("handles binary files", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-bin-"));
    const binary = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(resolve(tmp, "image.png"), binary);

    const files = collectFiles(tmp);
    assert.deepEqual(Buffer.from(files["image.png"], "base64"), binary);
  });

  it("skips symlinks", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-symlink-"));
    writeFileSync(resolve(tmp, "real.txt"), "real content");
    symlinkSync(resolve(tmp, "real.txt"), resolve(tmp, "link.txt"));

    const files = collectFiles(tmp);
    assert.equal(Object.keys(files).length, 1);
    assert.ok("real.txt" in files);
    assert.ok(!("link.txt" in files));
  });
});

// ---------------------------------------------------------------------------
// Mock server + CLI command integration tests
// ---------------------------------------------------------------------------

/** Sentinel error thrown by our mocked process.exit */
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

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

describe("pages CLI commands", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const MIND_NAME = "pages-test-mind";
  const originalPagesUrl = process.env.VOLUTE_SYSTEMS_URL;
  const originalMind = process.env.VOLUTE_MIND;

  before(async () => {
    // Start mock HTTP server
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.VOLUTE_SYSTEMS_URL = baseUrl;

    // Register a test mind so mindDir() works
    addMind(MIND_NAME, 14900);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalPagesUrl === undefined) delete process.env.VOLUTE_SYSTEMS_URL;
    else process.env.VOLUTE_SYSTEMS_URL = originalPagesUrl;
    if (originalMind === undefined) delete process.env.VOLUTE_MIND;
    else process.env.VOLUTE_MIND = originalMind;
    removeMind(MIND_NAME);
  });

  beforeEach(() => {
    // Reset handler to a 404 default
    handler = (_req, res) => {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    };
  });

  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
    mock.restoreAll();
  });

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------
  describe("register", () => {
    it("registers successfully and saves config", async () => {
      handler = async (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/api/register");
        const body = JSON.parse(await readBody(req));
        assert.equal(body.name, "my-system");
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ apiKey: "vp_newkey", system: "my-system" }));
      };

      const { run } = await import("../src/commands/pages/register.js");
      await run(["--name", "my-system"]);

      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_newkey");
      assert.equal(config?.system, "my-system");
      assert.equal(config?.apiUrl, baseUrl);
    });

    it("exits if already registered", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/register.js");
      await assert.rejects(() => run(["--name", "new-name"]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits on API conflict (name taken)", async () => {
      handler = (_req, res) => {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Name already taken" }));
      };

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/register.js");
      await assert.rejects(() => run(["--name", "taken-name"]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits when no --name and not a TTY", async () => {
      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/register.js");
      // stdin.isTTY is undefined in test env (not a TTY)
      await assert.rejects(() => run([]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------
  describe("login", () => {
    it("validates key via whoami and saves config", async () => {
      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, "/api/whoami");
        assert.equal(req.headers.authorization, "Bearer vp_mykey");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ system: "test-system" }));
      };

      const { run } = await import("../src/commands/pages/login.js");
      await run(["--key", "vp_mykey"]);

      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_mykey");
      assert.equal(config?.system, "test-system");
    });

    it("exits if already logged in", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/login.js");
      await assert.rejects(() => run(["--key", "vp_newkey"]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits on invalid key (401)", async () => {
      handler = (_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid API key" }));
      };

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/login.js");
      await assert.rejects(() => run(["--key", "vp_badkey"]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits when no --key and not a TTY", async () => {
      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/login.js");
      await assert.rejects(() => run([]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });
  });

  // -----------------------------------------------------------------------
  // publish
  // -----------------------------------------------------------------------
  describe("publish", () => {
    it("publishes files from pages/ directory", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });
      process.env.VOLUTE_MIND = MIND_NAME;

      // Create pages/ directory in the mind's home
      const pagesDir = resolve(mindDir(MIND_NAME), "home", "pages");
      mkdirSync(pagesDir, { recursive: true });
      writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hi</h1>");

      let receivedBody: { files: Record<string, string> } | undefined;
      handler = async (req, res) => {
        assert.equal(req.method, "PUT");
        assert.equal(req.url, `/api/pages/publish/${MIND_NAME}`);
        assert.equal(req.headers.authorization, "Bearer vp_pub");
        receivedBody = JSON.parse(await readBody(req));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: `https://my-system.volute.systems/~${MIND_NAME}/`,
            fileCount: 1,
          }),
        );
      };

      const { run } = await import("../src/commands/pages/publish.js");
      await run(["--mind", MIND_NAME]);

      assert.ok(receivedBody);
      assert.equal(Object.keys(receivedBody.files).length, 1);
      assert.ok("index.html" in receivedBody.files);
      assert.equal(
        Buffer.from(receivedBody.files["index.html"], "base64").toString(),
        "<h1>Hi</h1>",
      );
    });

    it("exits if not logged in", async () => {
      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/publish.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits if pages/ directory does not exist", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/publish.js");
      await assert.rejects(() => run(["--mind", "nonexistent-mind"]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits if pages/ directory is empty", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      const pagesDir = resolve(mindDir(MIND_NAME), "home", "pages");
      rmSync(pagesDir, { recursive: true, force: true });
      mkdirSync(pagesDir, { recursive: true });

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/publish.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits on API error", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      const pagesDir = resolve(mindDir(MIND_NAME), "home", "pages");
      mkdirSync(pagesDir, { recursive: true });
      writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hi</h1>");

      handler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      };

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/publish.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("publishes multiple files including nested paths", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      const pagesDir = resolve(mindDir(MIND_NAME), "home", "pages");
      mkdirSync(resolve(pagesDir, "css"), { recursive: true });
      mkdirSync(resolve(pagesDir, "img"), { recursive: true });
      writeFileSync(resolve(pagesDir, "index.html"), "<h1>Home</h1>");
      writeFileSync(resolve(pagesDir, "css", "style.css"), "body {}");
      writeFileSync(resolve(pagesDir, "img", "logo.png"), "fakepng");

      let receivedFiles: Record<string, string> = {};
      handler = async (req, res) => {
        const body = JSON.parse(await readBody(req));
        receivedFiles = body.files;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: "https://example.com", fileCount: 3 }));
      };

      const { run } = await import("../src/commands/pages/publish.js");
      await run(["--mind", MIND_NAME]);

      assert.equal(Object.keys(receivedFiles).length, 3);
      assert.ok("index.html" in receivedFiles);
      assert.ok("css/style.css" in receivedFiles);
      assert.ok("img/logo.png" in receivedFiles);
    });
  });

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------
  describe("status", () => {
    it("displays status from API", async () => {
      writeSystemsConfig({ apiKey: "vp_stat", system: "my-system", apiUrl: baseUrl });
      process.env.VOLUTE_MIND = MIND_NAME;

      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, `/api/pages/status/${MIND_NAME}`);
        assert.equal(req.headers.authorization, "Bearer vp_stat");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: `https://my-system.volute.systems/~${MIND_NAME}/`,
            fileCount: 5,
            deployedAt: "2026-01-15T12:00:00Z",
          }),
        );
      };

      const logged: string[] = [];
      const logMock = mock.method(console, "log", (msg: string) => logged.push(msg));

      const { run } = await import("../src/commands/pages/status.js");
      await run(["--mind", MIND_NAME]);

      logMock.mock.restore();
      assert.ok(logged.some((l) => l.includes("my-system.volute.systems")));
      assert.ok(logged.some((l) => l.includes("5")));
      assert.ok(logged.some((l) => l.includes("2026-01-15")));
    });

    it("handles 404 (not published yet)", async () => {
      writeSystemsConfig({ apiKey: "vp_stat", system: "my-system", apiUrl: baseUrl });

      handler = (_req, res) => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      };

      const logged: string[] = [];
      const logMock = mock.method(console, "log", (msg: string) => logged.push(msg));

      const { run } = await import("../src/commands/pages/status.js");
      await run(["--mind", MIND_NAME]);

      logMock.mock.restore();
      assert.ok(logged.some((l) => l.includes("has not been published yet")));
    });

    it("exits if not logged in", async () => {
      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/status.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });

    it("exits on API error", async () => {
      writeSystemsConfig({ apiKey: "vp_stat", system: "my-system", apiUrl: baseUrl });

      handler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server error" }));
      };

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });

      const { run } = await import("../src/commands/pages/status.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
    });
  });

  // -----------------------------------------------------------------------
  // logout
  // -----------------------------------------------------------------------
  describe("logout", () => {
    it("removes credentials when logged in", async () => {
      writeSystemsConfig({ apiKey: "vp_key", system: "test", apiUrl: baseUrl });
      assert.ok(existsSync(configPath()));

      const logged: string[] = [];
      const logMock = mock.method(console, "log", (msg: string) => logged.push(msg));

      const { run } = await import("../src/commands/pages/logout.js");
      await run();

      logMock.mock.restore();
      assert.ok(!existsSync(configPath()));
      assert.ok(logged.some((l) => l.includes("Logged out")));
    });

    it("prints message when not logged in", async () => {
      const logged: string[] = [];
      const logMock = mock.method(console, "log", (msg: string) => logged.push(msg));

      const { run } = await import("../src/commands/pages/logout.js");
      await run();

      logMock.mock.restore();
      assert.ok(logged.some((l) => l.includes("Not logged in")));
    });
  });

  // -----------------------------------------------------------------------
  // network errors
  // -----------------------------------------------------------------------
  describe("network errors", () => {
    it("shows friendly error on connection refused", async () => {
      // Point at a port that nothing is listening on
      writeSystemsConfig({
        apiKey: "vp_key",
        system: "test",
        apiUrl: "http://127.0.0.1:1",
      });

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });
      const errors: string[] = [];
      const errMock = mock.method(console, "error", (msg: string) => errors.push(msg));

      const { run } = await import("../src/commands/pages/status.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);

      errMock.mock.restore();
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
      assert.ok(errors.some((e) => e.includes("127.0.0.1:1")));
    });
  });

  // -----------------------------------------------------------------------
  // non-JSON error response
  // -----------------------------------------------------------------------
  describe("non-JSON error responses", () => {
    it("handles plain text error response gracefully", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      const pagesDir = resolve(mindDir(MIND_NAME), "home", "pages");
      mkdirSync(pagesDir, { recursive: true });
      writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hi</h1>");

      handler = (_req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      };

      const exitMock = mock.method(process, "exit", (code: number) => {
        throw new ExitError(code);
      });
      const errors: string[] = [];
      const errMock = mock.method(console, "error", (msg: string) => errors.push(msg));

      const { run } = await import("../src/commands/pages/publish.js");
      await assert.rejects(() => run(["--mind", MIND_NAME]), ExitError);

      errMock.mock.restore();
      assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
      assert.ok(errors.some((e) => e.includes("Publish failed")));
    });
  });
});
